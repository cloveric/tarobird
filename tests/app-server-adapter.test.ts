import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";
import type { AppPlatformTools, EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import { EngineContextCompactionPendingError } from "../src/codex/adapter.js";
import { createRunRecord, recordRunEvent } from "../src/core/run-record.js";
import { classifyFailure } from "../src/runtime/error-classification.js";

import {
  CODEX_APP_SERVER_AUTO_COMPACT_RATIO,
  CODEX_APP_SERVER_COMPACTION_CEILING_MS,
  CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS,
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS,
  CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS,
  CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS,
  CODEX_APP_SERVER_TURN_TIMEOUT_MS,
  CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS,
  CODEX_GOAL_FINAL_TURN_TIMEOUT_MS,
  CodexAppServerAdapter,
  codexPlanTodos,
  extractCodexToolItem,
} from "../src/codex/app-server-adapter.js";

describe("preventive compaction completion deadlines", () => {
  function fixture(acknowledge = true) {
    const adapter = new CodexAppServerAdapter("codex", "/tmp/compaction-deadline");
    const engine = adapter as unknown as {
      child?: FakeChildProcess;
      childGeneration: number;
      threadContextUsage: Map<string, { totalTokens: number; modelContextWindow: number }>;
      pendingCompactions: Map<string, { expired?: boolean }>;
      activeTurnEntries: Set<string>;
      completingTurns: number;
      goalWatchers: Map<string, { resolve: (goal: unknown) => void; latestGoal: unknown }>;
      request(method: string, params: unknown): Promise<unknown>;
      prepareThreadForTurn(threadId: string, cwd: string, tools: undefined, event: (event: EngineStreamEvent) => void, signal?: AbortSignal): Promise<string>;
      handleMessage(line: string): void;
      notifyIdleWaitersIfIdle(): void;
      isIdle(): boolean;
    };
    const saturate = () => engine.threadContextUsage.set("original-context", { totalTokens: 235369, modelContextWindow: 258400 });
    saturate();
    const request = vi.spyOn(engine, "request");
    if (acknowledge) request.mockImplementation(async method => method === "thread/start" ? { thread: { id: "replacement-context" } } : {});
    else engine.child = createSpawnHarness().child;
    const destroy = vi.spyOn(adapter, "destroy");
    const events: EngineStreamEvent[] = [];
    const start = (signal?: AbortSignal) => engine.prepareThreadForTurn("original-context", "/tmp/compaction-deadline", undefined, event => { events.push(event); }, signal);
    const outcome = (signal?: AbortSignal) => start(signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
    const completed = () => engine.handleMessage(JSON.stringify({ method: "thread/compacted", params: { threadId: "original-context" } }));
    const statuses = () => events.map(event => "status" in event && event.status);
    const methods = () => request.mock.calls.map(([method]) => method);
    return { adapter, engine, request, destroy, events, start, outcome, completed, saturate, statuses, methods };
  }

  it("keeps the original context when native compaction takes the observed 204 seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      let settled = false;
      const result = f.start().finally(() => { settled = true; });
      void result.catch(() => {});
      await vi.advanceTimersByTimeAsync(204_000);
      expect(settled).toBe(false);
      expect(f.methods()).toEqual(["thread/compact/start"]);
      f.completed();
      await expect(result).resolves.toBe("original-context");
      expect(f.statuses()).toEqual(["started", "completed"]);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("reports an unknown deadline, fences retries as still waiting and accepts a late success", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const first = f.outcome();
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      const timedOut = (await first).error;
      expect(timedOut).toBeInstanceOf(EngineContextCompactionPendingError);
      expect(timedOut).toMatchObject({ state: "timed-out", limitMs: CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS });
      expect(timedOut?.message).not.toMatch(/fail/i);
      expect(f.statuses()).toEqual(["started", "unknown"]);
      expect(f.engine.isIdle()).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      const retry = (await f.outcome()).error;
      expect(retry).toMatchObject({ state: "waiting" });
      expect(retry?.message).toMatch(/started 6 minutes ago is still unconfirmed; no second compaction/);
      // The retry neither starts nor reports another maintenance operation.
      expect(f.statuses()).toEqual(["started", "unknown"]);
      expect(f.methods()).toEqual(["thread/compact/start"]);

      await vi.advanceTimersByTimeAsync(240_000);
      f.completed();
      expect(f.engine.isIdle()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_CEILING_MS);
      expect(f.destroy).not.toHaveBeenCalled();
      await expect(f.start()).resolves.toBe("original-context");
      expect(f.methods()).toEqual(["thread/compact/start"]);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it.each(["completion", "exit"])("retains an unacknowledged RPC until native %s", async terminal => {
    vi.useFakeTimers();
    const f = fixture(false);
    try {
      const result = f.start().catch(error => error as Error);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      expect(await result).toMatchObject({ state: "timed-out" });
      expect(f.engine.isIdle()).toBe(false);
      await expect(f.start()).rejects.toMatchObject({ state: "waiting" });
      expect(f.methods()).toEqual(["thread/compact/start"]);
      if (terminal === "exit") f.adapter.destroy();
      else f.engine.handleMessage(JSON.stringify({ method: "turn/completed", params: {
        threadId: "original-context", turn: { id: "compaction-turn", status: "completed", items: [], error: null },
      } }));
      expect(f.engine.isIdle()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await expect(f.start()).resolves.toBe("original-context");
      expect(f.request).toHaveBeenCalledTimes(1);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("recycles an otherwise idle child at the ceiling and resumes the original thread", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      void f.start().catch(() => {});
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      const generation = f.engine.childGeneration;
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_CEILING_MS - CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS - 1);
      expect(f.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.destroy).toHaveBeenCalledTimes(1);
      expect(f.destroy).toHaveBeenCalledWith(generation, expect.stringMatching(/context compaction reported no terminal state; the original thread is preserved/));
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/no terminal state within 15 minutes/));
      expect(f.engine.pendingCompactions.size).toBe(0);
      expect(f.engine.isIdle()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // Recycling clears the stale pre-compaction usage: the original thread is
      // resumed as-is, without a second compaction or a replacement thread.
      await expect(f.start()).resolves.toBe("original-context");
      expect(f.methods()).toEqual(["thread/compact/start"]);
    } finally { errors.mockRestore(); f.adapter.destroy(); vi.useRealTimers(); }
  });

  it.each([
    ["an unrelated turn", (f: ReturnType<typeof fixture>) => { f.engine.activeTurnEntries.add("other-thread"); return () => f.engine.activeTurnEntries.delete("other-thread"); }],
    ["a completing turn", (f: ReturnType<typeof fixture>) => { f.engine.completingTurns = 1; return () => { f.engine.completingTurns = 0; }; }],
    ["a goal watcher", (f: ReturnType<typeof fixture>) => { f.engine.goalWatchers.set("goal-thread", { resolve: () => {}, latestGoal: null }); return () => f.engine.goalWatchers.delete("goal-thread"); }],
  ] as const)("never recycles beneath %s; the expired thread reports recovery until it settles", async (_name, occupy) => {
    vi.useFakeTimers();
    const f = fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      void f.start().catch(() => {});
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      const release = occupy(f);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_CEILING_MS);
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.engine.pendingCompactions.get("original-context")?.expired).toBe(true);
      // Busy only because of the unrelated work: the expired compaction no
      // longer holds the idle/config gate by itself.
      expect(f.engine.isIdle()).toBe(false);
      // The fenced thread still refuses a turn on the old child.
      await expect(f.start()).rejects.toMatchObject({ state: "recovering", limitMs: CODEX_APP_SERVER_COMPACTION_CEILING_MS });
      expect(f.destroy).not.toHaveBeenCalled();
      release();
      expect(f.engine.isIdle()).toBe(true);
      // Settling work always notifies idle waiters; that is when the child is replaced.
      f.engine.notifyIdleWaitersIfIdle();
      expect(f.destroy).toHaveBeenCalledTimes(1);
      await expect(f.start()).resolves.toBe("original-context");
      expect(f.methods()).toEqual(["thread/compact/start"]);
    } finally { errors.mockRestore(); f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("does not let a settled operation's ceiling expire a later compaction on the same thread", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      void f.start().catch(() => {});
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(100_000);
      f.completed();
      // A second compaction starts 400 s in; the first one's ceiling (900 s)
      // and the second one's wait deadline (700 s) must stay independent.
      f.saturate();
      const second = f.outcome();
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      expect((await second).error).toMatchObject({ state: "timed-out" });
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_CEILING_MS - 400_000 - CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS + 1_000);
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.engine.pendingCompactions.get("original-context")?.expired).toBeFalsy();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(f.destroy).toHaveBeenCalledTimes(1);
      expect(f.methods()).toEqual(["thread/compact/start", "thread/compact/start"]);
    } finally { errors.mockRestore(); f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("does not apply an old RPC deadline to a later compaction on the same thread", async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    try {
      const first = f.start();
      await vi.advanceTimersByTimeAsync(204_000);
      f.completed();
      await expect(first).resolves.toBe("original-context");
      f.saturate();
      let settled = false;
      const second = f.start().finally(() => { settled = true; });
      void second.catch(() => {});
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS - 204_000);
      expect(settled).toBe(false);
      f.completed();
      await expect(second).resolves.toBe("original-context");
      expect(f.statuses()).toEqual(["started", "completed", "started", "completed"]);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("lets Stop end the wait while the native compaction stays tracked for the next message", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const stop = new AbortController();
      const stopped = f.outcome(stop.signal);
      await vi.advanceTimersByTimeAsync(10_000);
      stop.abort();
      expect((await stopped).error?.message).toMatch(/aborted during context compaction/);
      expect(f.statuses()).toEqual(["started", "unknown"]);
      expect(f.engine.isIdle()).toBe(false);
      // An already stopped message never starts maintenance.
      await expect(f.start(stop.signal)).resolves.toBe("original-context");
      // The next message joins the same native operation instead of starting another.
      const next = f.start();
      await vi.advanceTimersByTimeAsync(50_000);
      f.completed();
      await expect(next).resolves.toBe("original-context");
      expect(f.methods()).toEqual(["thread/compact/start"]);
      expect(f.statuses()).toEqual(["started", "unknown", "started", "completed"]);
      expect(f.engine.isIdle()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("does not start maintenance when Stop arrives while the start is being reported", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const stop = new AbortController();
      const stopped = f.engine.prepareThreadForTurn("original-context", "/tmp/compaction-deadline", undefined, event => {
        f.events.push(event);
        if ("status" in event && event.status === "started") stop.abort();
      }, stop.signal);
      await expect(stopped).rejects.toThrow(/aborted during context compaction/);
      expect(f.methods()).toEqual([]);
      expect(f.statuses()).toEqual(["started", "unknown"]);
      expect(f.engine.pendingCompactions.size).toBe(0);
      expect(f.engine.isIdle()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // Pressure is unchanged, so the next message performs the real compaction.
      const next = f.start();
      await vi.advanceTimersByTimeAsync(1_000);
      f.completed();
      await expect(next).resolves.toBe("original-context");
      expect(f.methods()).toEqual(["thread/compact/start"]);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it.each([["forward", 3_600_000], ["backward", -3_600_000]] as const)("keeps the hard ceiling on elapsed time when the wall clock jumps %s", async (_direction, jump) => {
    vi.useFakeTimers();
    const f = fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = f.outcome();
      await vi.advanceTimersByTimeAsync(10_000);
      vi.setSystemTime(Date.now() + jump);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS - 10_000);
      expect((await first).error).toMatchObject({ state: "timed-out" });
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_CEILING_MS - CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS - 1);
      expect(f.destroy).not.toHaveBeenCalled();
      await expect(f.start()).rejects.toMatchObject({ state: "waiting" });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.destroy).toHaveBeenCalledTimes(1);
      await expect(f.start()).resolves.toBe("original-context");
    } finally { errors.mockRestore(); f.adapter.destroy(); vi.useRealTimers(); }
  });

  it.each([
    ["before its wait deadline", 10_000, "waiting"],
    ["after its wait deadline", CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS, "waiting"],
    ["past its ceiling", CODEX_APP_SERVER_COMPACTION_CEILING_MS, "recovering"],
  ] as const)("refuses goal writes beside a compaction %s and accepts them after recovery", async (_name, elapsed, state) => {
    vi.useFakeTimers();
    const f = fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = f.engine as unknown as Record<string, unknown>;
    vi.spyOn(engine as { loadRuntimeOptions(): Promise<unknown> }, "loadRuntimeOptions").mockResolvedValue({});
    vi.spyOn(engine as { ensureInitialized(): Promise<void> }, "ensureInitialized").mockResolvedValue(undefined);
    vi.spyOn(engine as { resolveThreadForMessageWithRetry(): Promise<string> }, "resolveThreadForMessageWithRetry").mockResolvedValue("original-context");
    try {
      void f.start().catch(() => {});
      // Keep an expired operation fenced (not yet recycled) behind unrelated work.
      if (state === "recovering") f.engine.activeTurnEntries.add("other-thread");
      await vi.advanceTimersByTimeAsync(elapsed);
      await expect(f.adapter.setThreadGoal("original-context", { objective: "must wait" })).rejects.toMatchObject({ state });
      await expect(f.adapter.watchThreadGoal("original-context", { objective: "must wait" })).rejects.toMatchObject({ state });
      expect(f.methods()).toEqual(["thread/compact/start"]);
      expect(f.engine.goalWatchers.size).toBe(0);
      expect(f.destroy).not.toHaveBeenCalled();

      if (state === "recovering") {
        f.engine.activeTurnEntries.delete("other-thread");
        f.engine.notifyIdleWaitersIfIdle();
        expect(f.destroy).toHaveBeenCalledTimes(1);
      } else f.completed();
      expect(f.engine.pendingCompactions.size).toBe(0);

      await f.adapter.setThreadGoal("original-context", { objective: "retry" });
      const stop = new AbortController();
      const watch = f.adapter.watchThreadGoal("original-context", { objective: "retry", abortSignal: stop.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.engine.goalWatchers.has("original-context")).toBe(true);
      expect(f.methods()).toEqual(["thread/compact/start", "thread/goal/set", "thread/goal/clear", "thread/goal/set"]);
      stop.abort();
      await watch;
    } finally { errors.mockRestore(); f.adapter.destroy(); vi.useRealTimers(); }
  });

  it("clears the wait and ceiling timers when the adapter is destroyed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      void f.start().catch(() => {});
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS);
      expect(vi.getTimerCount()).toBe(1);
      f.adapter.destroy();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.engine.isIdle()).toBe(true);
      await expect(f.start()).resolves.toBe("original-context");
      expect(f.methods()).toEqual(["thread/compact/start"]);
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });
});

describe("extractCodexToolItem", () => {
  it("maps a command execution item to a Bash tool event", () => {
    expect(extractCodexToolItem({
      id: "c1",
      type: "commandExecution",
      command: "npm test",
      aggregatedOutput: "ok",
      exitCode: 0,
      status: "completed",
    })).toEqual({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolUseId: "c1",
      output: "ok",
      exitCode: 0,
      isError: false,
    });
  });

  it("preserves actual diffs, exit duration and structured MCP results", () => {
    expect(extractCodexToolItem({ type: "commandExecution", command: "false", exitCode: 2, durationMs: 1200 })).toMatchObject({ exitCode: 2, durationMs: 1200, isError: true });
    const changes = [{ path: "/work/report.md", diff: "@@ -1 +1 @@\n-old\n+new" }];
    expect(extractCodexToolItem({ type: "fileChange", changes })).toMatchObject({ toolInput: { file_path: "/work/report.md" }, changes });
    expect(extractCodexToolItem({ type: "mcpToolCall", result: { content: [{ type: "text", text: "full output" }] } })?.output).toContain("full output");
    expect(extractCodexToolItem({ type: "webSearch", query: "docs", sources: [{ url: "https://example.com", title: "Example" }, null] })?.sources).toEqual([{ url: "https://example.com", title: "Example" }]);
  });
  it("normalizes native add/delete full-file receipts without losing an empty file", () => {
    const change = (type: string, diff: string) => extractCodexToolItem({ type: "fileChange", changes: [{ path: "/work/file.ts", kind: { type }, diff }] })?.changes?.[0]?.diff;
    expect(change("add", "one\ntwo\n")).toBe("@@ -0,0 +1,2 @@\n+one\n+two");
    expect(change("delete", "")).toBe("");
    expect(change("delete", "old")).toBe("@@ -1,1 +0,0 @@\n-old\n\\ No newline at end of file");
    expect(change("add", "")).toBe("@@ -0,0 +0,0 @@");
    expect(change("update", "@@ -1 +1 @@\n-old\n+new")).toBe("@@ -1 +1 @@\n-old\n+new");
  });

  it("flags a non-zero command exit as a tool error", () => {
    expect(extractCodexToolItem({ type: "command_execution", command: "false", exit_code: 1 }))
      .toMatchObject({ toolName: "Bash", isError: true });
  });

  it("maps file change, mcp tool call, and web search items", () => {
    expect(extractCodexToolItem({ type: "fileChange", path: "/a/b.ts", status: "completed" }))
      .toMatchObject({ toolName: "Edit", toolInput: { file_path: "/a/b.ts" }, isError: false });
    expect(extractCodexToolItem({ type: "mcpToolCall", server: "web", tool: "search", arguments: { q: "x" } }))
      .toMatchObject({ toolName: "web.search", toolInput: { q: "x" } });
    expect(extractCodexToolItem({ type: "webSearch", query: "tarocub" }))
      .toMatchObject({ toolName: "WebSearch", toolInput: { query: "tarocub" } });
  });

  it("does not report an MCP error or declined edit as successful completion", () => {
    expect(extractCodexToolItem({ type: "mcpToolCall", status: "completed", result: { isError: true, content: [{ type: "text", text: "access denied" }] } })).toMatchObject({ isError: true });
    expect(extractCodexToolItem({ type: "mcpToolCall", status: "failed", error: { message: "server unavailable" } })).toMatchObject({ isError: true, output: '{"message":"server unavailable"}' });
    expect(extractCodexToolItem({ type: "fileChange", status: "declined" })).toMatchObject({ isError: true });
  });

  it("returns null for non-tool items", () => {
    expect(extractCodexToolItem({ type: "agentMessage", text: "hi" })).toBeNull();
    expect(extractCodexToolItem(null)).toBeNull();
    expect(extractCodexToolItem("nope")).toBeNull();
  });

  it("maps a Codex plan item to a TodoWrite event (so the plan panel renders)", () => {
    // Shape confirmed from the Codex app-server: turn/plan/updated → { plan: [{step, status}] }.
    expect(extractCodexToolItem({
      type: "plan",
      plan: [
        { step: "Read the code", status: "completed" },
        { step: "Write tests", status: "in_progress" },
        { step: "Ship", status: "pending" },
      ],
    })).toMatchObject({
      toolName: "TodoWrite",
      toolInput: { todos: [
        { content: "Read the code", status: "completed" },
        { content: "Write tests", status: "in_progress" },
        { content: "Ship", status: "pending" },
      ] },
    });
  });
});

describe("Codex public collaboration visibility", () => {
  it("keeps native collaboration tool requests and returned agent reports", () => {
    expect(extractCodexToolItem({ type: "collabAgentToolCall", id: "delegate-1", tool: "wait", status: "completed",
      receiverThreadIds: ["child-1"], prompt: "Review the fixture", model: "fixture-model", reasoningEffort: "xhigh",
      agentsStates: { "child-1": { status: "completed", message: "Confirmed the fixture bug." } } })).toMatchObject({
      toolName: "CodexAgent", toolUseId: "delegate-1", isError: false,
      toolInput: { action: "wait", receiverThreadIds: ["child-1"], prompt: "Review the fixture" },
      output: expect.stringContaining("Confirmed the fixture bug."),
    });
    expect(extractCodexToolItem({ type: "collabAgentToolCall", id: "delegate-2", tool: "spawnAgent", status: "failed", agentsStates: {} })).toMatchObject({ isError: true });
  });

  it("records typed child activities only in the owning turn without completing the parent", async () => {
    const f = await goalFixture();
    try {
      f.emit("turn/started", { turn: { id: "owned-turn" } });
      for (const kind of ["started", "interacted", "interrupted", "completed"]) {
        const item = { type: "subAgentActivity", id: `activity-${kind}`, kind, agentThreadId: "child-1", agentPath: "/root/reviewer", model: "fixture-model", reasoningEffort: "xhigh" };
        f.emit("item/completed", { turnId: "owned-turn", item });
        f.emit("item/completed", { turnId: "foreign-turn", item: { ...item, id: `foreign-${kind}` } });
        f.emit("item/completed", { threadId: "child-1", turnId: "owned-turn", item: { ...item, id: `child-${kind}` } });
      }
      expect(f.events.filter((e: any) => e.type === "subagent_activity")).toEqual(
        ["started", "interacted", "interrupted", "completed"].map(kind => ({ type: "subagent_activity", id: `activity-${kind}`, kind, agentId: "child-1", label: "/root/reviewer", model: "fixture-model", effort: "xhigh", sessionId: f.goal.threadId })));
      expect(f.events.some((e: any) => e.type === "result")).toBe(false);
      expect(f.frames().map(frame => frame.method)).not.toContain("thread/read");
      f.emit("item/completed", { turnId: "owned-turn", item: { type: "subAgentActivity", id: "bad", kind: "invented", agentThreadId: "child-1", agentPath: "/root/reviewer" } });
      expect(f.events.filter((e: any) => e.type === "subagent_activity")).toHaveLength(4);
    } finally { f.abort.abort(); f.adapter.destroy(); }
  });

  it("captures foreground receipts on started and completed, merging native ids without admitting foreign work", async () => {
    const f = await foregroundFixture();
    try {
      for (const kind of ["started", "interacted", "interrupted", "completed"]) {
        const item = { type: "subAgentActivity", id: `receipt-${kind}`, kind, agentThreadId: "child", agentPath: "/root/reviewer" };
        f.emit("item/started", { turnId: f.turnId, item });
        expect(f.record.entries.some(entry => entry.callId === item.id)).toBe(true);
        f.emit("item/completed", { turnId: f.turnId, item });
        for (const method of ["item/started", "item/completed"]) {
          f.emit(method, { turnId: "foreign", item: { ...item, id: "foreign-receipt" } });
          f.emit(method, { threadId: "child", turnId: f.turnId, item: { ...item, id: "child-receipt" } });
        }
      }
      expect(f.record.entries).toHaveLength(4);
      expect(f.record.phase).toBe("thinking");
      expect(f.record.endedAt).toBeUndefined();
      expect(f.record.entries.every(entry => entry.kind === "text" && entry.status === "done" && !entry.endedAt)).toBe(true);

      const item = { type: "collabAgentToolCall", id: "collab", tool: "wait", status: "inProgress", receiverThreadIds: [] };
      for (const method of ["item/started", "item/completed"]) {
        f.emit(method, { turnId: "foreign", item: { ...item, id: "foreign-collab" } });
        f.emit(method, { threadId: "child", turnId: f.turnId, item: { ...item, id: "child-collab" } });
      }
      f.emit("item/started", { turnId: f.turnId, item });
      expect(f.record.entries.find(entry => entry.callId === "collab")?.status).toBe("running");
      const agentsStates = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`child-${i}`, { status: "completed", message: "report".repeat(5000) }]));
      f.emit("item/completed", { turnId: f.turnId, item: { ...item, status: "completed", receiverThreadIds: Object.keys(agentsStates), agentsStates } });
      const tools = f.record.entries.filter(entry => entry.kind === "tool");
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ callId: "collab", status: "done", truncated: true });
      expect(JSON.parse(tools[0]!.input!).receiverThreadIds).toEqual(Object.keys(agentsStates));
      expect(Object.keys(JSON.parse(tools[0]!.output!))).toEqual(Object.keys(agentsStates));
      expect(f.record.endedAt).toBeUndefined();
      expect(f.frames().map(frame => frame.method)).not.toContain("thread/read");
      await f.finish();
      const events = f.events.length;
      f.emit("item/completed", { turnId: f.turnId, item: { type: "subAgentActivity", id: "late", kind: "completed", agentThreadId: "child", agentPath: "/root/reviewer" } });
      expect(f.events).toHaveLength(events);
    } finally { f.adapter.destroy(); }
  });

  it("routes buffered foreground and goal receipts separately after turn/start confirms ownership", async () => {
    const f = await goalFixture(), ordinaryRecord = createRunRecord();
    try {
      f.emit("turn/started", { turn: { id: "goal-live" } });
      const ordinary = f.adapter.sendUserMessage(f.goal.threadId, { text: "ordinary", files: [], onEngineEvent: event => { recordRunEvent(ordinaryRecord, event); } });
      void ordinary.catch(() => {});
      await waitFor(() => f.frames().some(frame => frame.method === "turn/start"));
      for (const turnId of ["ordinary", "goal-live", "foreign"]) {
        const item = { type: "subAgentActivity", id: "shared-receipt", kind: "started", agentThreadId: `${turnId}-child`, agentPath: `/root/${turnId}` };
        const collab = { type: "collabAgentToolCall", id: "shared-tool", tool: "spawnAgent", status: "inProgress" };
        f.emit("item/started", { turnId, item });
        f.emit("item/completed", { turnId, item });
        f.emit("item/started", { turnId, item: collab });
        f.emit("item/completed", { turnId, item: { ...collab, status: "completed", receiverThreadIds: [`${turnId}-child`], agentsStates: { [`${turnId}-child`]: { status: "running", message: null } } } });
        f.emit("item/completed", { threadId: `${turnId}-child`, turnId, item: { ...item, id: "child-owned" } });
      }
      expect(ordinaryRecord.entries).toHaveLength(0);
      expect(f.events.filter((event: any) => ["subagent_activity", "tool_use", "tool_result"].includes(event.type))).toHaveLength(0);
      await f.respond("turn/start", { turn: { id: "ordinary" } });
      await waitFor(() => ordinaryRecord.entries.length === 2);
      const goalRecord = createRunRecord();
      for (const event of f.events) recordRunEvent(goalRecord, event as EngineStreamEvent);
      for (const [record, owner] of [[ordinaryRecord, "ordinary"], [goalRecord, "goal-live"]] as const) {
        expect(record.entries).toHaveLength(2);
        expect(record.entries.find(entry => entry.kind === "text")?.input).toContain(`${owner}-child`);
        expect(JSON.parse(record.entries.find(entry => entry.kind === "tool")!.output!)).toEqual({ [`${owner}-child`]: { status: "running", message: null } });
        expect(record.endedAt).toBeUndefined();
        expect(JSON.stringify(record)).not.toContain("foreign");
        expect(JSON.stringify(record)).not.toContain("child-owned");
      }
      f.emit("turn/completed", { turn: { id: "ordinary", status: "completed", items: [{ type: "agentMessage", text: "ordinary final" }] } });
      expect((await ordinary).text).toBe("ordinary final");
      expect(f.frames().map(frame => frame.method)).not.toContain("thread/read");
    } finally { f.abort.abort(); f.adapter.destroy(); }
  });
});

describe("codexPlanTodos", () => {
  it("converts Codex plan steps to TodoWrite todos", () => {
    expect(codexPlanTodos([{ step: "A", status: "completed" }, { step: "B", status: "pending" }])).toEqual([
      { content: "A", status: "completed", activeForm: "A" },
      { content: "B", status: "pending", activeForm: "B" },
    ]);
  });
  it("accepts a { steps: [...] } wrapper and drops empty steps", () => {
    expect(codexPlanTodos({ steps: [{ step: "X", status: "in_progress" }, { step: "  ", status: "pending" }] }))
      .toEqual([{ content: "X", status: "in_progress", activeForm: "X" }]);
  });
  it("returns null for nothing usable", () => {
    expect(codexPlanTodos(undefined)).toBeNull();
    expect(codexPlanTodos([])).toBeNull();
    expect(codexPlanTodos("nope")).toBeNull();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Condition was not met in time");
}

async function goalFixture() {
  const { child, spawnFn } = createSpawnHarness();
  const adapter = new CodexAppServerAdapter("codex", "/tmp/goal-fixture", spawnFn), abort = new AbortController(), events: unknown[] = [];
  const goal = { threadId: "goal-thread", objective: "goal work", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  const watch = adapter.watchThreadGoal("telegram-goal-fixture", { objective: goal.objective, abortSignal: abort.signal, onEngineEvent: (event) => { events.push(event); } });
  void watch.catch(() => {});
  const frames = () => child.stdin.lines.map((line) => JSON.parse(line));
  const respond = async (method: string, result: unknown, count = 1) => {
    await waitFor(() => frames().filter((frame) => frame.method === method).length >= count);
    child.stdout.emitData(JSON.stringify({ id: frames().filter((frame) => frame.method === method)[count - 1]!.id, result }) + "\n");
  };
  const emit = (method: string, fields: Record<string, unknown>) => child.stdout.emitData(JSON.stringify({ method, params: { threadId: goal.threadId, ...fields } }) + "\n");
  await respond("initialize", {}); await respond("thread/start", { thread: { id: goal.threadId } });
  await respond("thread/goal/clear", { cleared: false }); await respond("thread/goal/set", { goal });
  return { adapter, abort, events, goal, watch, frames, respond, emit };
}

async function foregroundFixture() {
  const { child, spawnFn } = createSpawnHarness();
  const adapter = new CodexAppServerAdapter("codex", "/tmp/collaboration-fixture", spawnFn);
  const threadId = "foreground-thread", turnId = "foreground-turn", events: EngineStreamEvent[] = [], record = createRunRecord();
  const turn = adapter.sendUserMessage("tarobot-collaboration", { text: "Review", files: [], onEngineEvent: event => { events.push(event); recordRunEvent(record, event); } });
  void turn.catch(() => {});
  const frames = () => child.stdin.lines.map(line => JSON.parse(line));
  for (const [method, result] of [["initialize", {}], ["thread/start", { thread: { id: threadId } }], ["turn/start", { turn: { id: turnId } }]] as const) {
    await waitFor(() => frames().some(frame => frame.method === method));
    child.stdout.emitData(JSON.stringify({ id: frames().find(frame => frame.method === method)!.id, result }) + "\n");
  }
  await new Promise(resolve => setImmediate(resolve));
  const emit = (method: string, fields: Record<string, unknown>) => child.stdout.emitData(JSON.stringify({ method, params: { threadId, ...fields } }) + "\n");
  const finish = async () => {
    emit("turn/completed", { turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", text: "Done" }] } });
    await turn;
  };
  return { adapter, events, record, frames, emit, finish, threadId, turnId };
}

class FakeStream extends EventEmitter {
  emitData(chunk: string | Buffer) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  lines: string[] = [];
  nextError: Error | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) {
      this.lines.push(text);
    }
    const error = this.nextError;
    this.nextError = null;
    callback?.(error);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
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
  const child = new FakeChildProcess();
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
    calls.push({ command, args, options });
    return child;
  };

  return { child, calls, spawnFn };
}

describe("Codex native user input lifecycle", () => {
  const question = { threadId: "thread-question", turnId: "turn-question", itemId: "question-item", isBlocking: true, questions: [{ id: "color", header: "Color", question: "Choose a color", options: [{ label: "Blue", description: "Calm" }, { label: "Green", description: "Fresh" }] }] };
  async function boot(onApprovalRequest: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>, configPath?: string) {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);
    const controller = new AbortController(), onEngineEvent = vi.fn();
    const turn = adapter.sendUserMessage("new-question", { text: "Ask", files: [], onApprovalRequest, onEngineEvent, abortSignal: controller.signal });
    void turn.catch(() => undefined);
    for (const [index, result] of [{ platformOs: "macos" }, { thread: { id: question.threadId } }, { turn: { id: question.turnId } }].entries()) {
      await waitFor(() => child.stdin.lines.length > index);
      child.stdout.emitData(JSON.stringify({ id: JSON.parse(child.stdin.lines[index]!).id, result }) + "\n");
    }
    await new Promise((resolve) => setImmediate(resolve));
    const request = (params: unknown = question, method = "item/tool/requestUserInput") => child.stdout.emitData(JSON.stringify({ id: "native-question", method, params }) + "\n");
    const finish = () => child.stdout.emitData(JSON.stringify({ method: "turn/completed", params: { threadId: question.threadId, turn: { id: question.turnId, status: "completed", items: [{ type: "agentMessage", text: "Done" }] } } }) + "\n");
    const responses = () => child.stdin.lines.map((s) => JSON.parse(s)).filter((s) => s.id === "native-question");
    return { adapter, child, controller, onEngineEvent, turn, request, finish, responses };
  }

  it.each(["normal", "bypass", "full-auto"])("asks for a real answer in %s mode without widening tool approvals", async (approvalMode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-question-"));
    const configPath = path.join(root, "config.json"); await writeFile(configPath, JSON.stringify({ approvalMode }));
    const callback = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: { answers: { "Choose a color": "Blue" } } });
    const h = await boot(callback, configPath);
    try {
      h.request(); await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0]).toEqual({ jsonrpc: "2.0", id: "native-question", result: { answers: { color: { answers: ["Blue"] } } } });
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", toolName: "AskUserQuestion", abortSignal: expect.any(AbortSignal) }));
      expect(h.onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: question.itemId, toolName: "AskUserQuestion" }));
      expect(JSON.parse(h.child.stdin.lines[2]!).params.approvalPolicy).toBe(approvalMode === "normal" ? "on-request" : "never");
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); await removeTempRoot(root); }
  });

  it.each(["abort", "resolved", "complete", "child"])("retires an unanswered form on %s and ignores the late answer", async (reason) => {
    let answer!: (decision: EngineApprovalDecision) => void;
    let signal: AbortSignal | undefined;
    const callback = vi.fn((request: EngineApprovalRequest) => { signal = request.abortSignal; return new Promise<EngineApprovalDecision>((resolve) => { answer = resolve; }); });
    const h = await boot(callback);
    try {
      h.request(); await waitFor(() => callback.mock.calls.length === 1);
      if (reason === "abort") h.controller.abort();
      else if (reason === "complete") h.finish();
      else if (reason === "child") h.child.close(1);
      else {
        h.child.stdout.emitData(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "other-thread", requestId: "native-question" } }) + "\n");
        expect(signal!.aborted).toBe(false);
        h.child.stdout.emitData(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: question.threadId, requestId: "native-question" } }) + "\n");
      }
      await waitFor(() => signal!.aborted);
      answer({ behavior: "allow", updatedInput: { answers: { "Choose a color": "Green" } } });
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.responses()).toEqual(["abort", "complete"].includes(reason) ? [{ jsonrpc: "2.0", id: "native-question", result: { answers: {} } }] : []);
      if (reason === "resolved") h.finish();
      await h.turn.catch(() => undefined);
    } finally { h.adapter.destroy(); }
  });

  it.each(["wrong-thread", "wrong-turn", "secret", "bad-options"])("declines %s without dispatching to another conversation or ending the turn", async (kind) => {
    const callback = vi.fn().mockResolvedValue({ behavior: "deny" });
    const h = await boot(callback);
    try {
      const params = kind === "wrong-thread" ? { ...question, threadId: "other" } : kind === "wrong-turn" ? { ...question, turnId: "other" } : { ...question, questions: [{ ...question.questions[0], ...(kind === "secret" ? { isSecret: true } : { options: [null] }) }] };
      h.request(params); await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result).toEqual({ answers: {} }); expect(callback).not.toHaveBeenCalled();
      h.finish(); await expect(h.turn).resolves.toMatchObject({ text: "Done" });
    } finally { h.adapter.destroy(); }
  });

  it("routes MCP elicitation through the same scoped form and returns server values", async () => {
    const callback = vi.fn(async (input: EngineApprovalRequest): Promise<EngineApprovalDecision> => {
      const value = input.toolInput as { questions: { question: string }[] };
      return { behavior: "allow", updatedInput: { answers: { [value.questions[0]!.question]: "Blue" } } };
    });
    const h = await boot(callback);
    try {
      h.request({ threadId: question.threadId, turnId: question.turnId, serverName: "fixture", mode: "form", message: "Pick", requestedSchema: { type: "object", properties: { color: { type: "string", oneOf: [{ const: "blue", title: "Blue" }] } }, required: ["color"] } }, "mcpServer/elicitation/request");
      await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result).toEqual({ action: "accept", content: { color: "blue" } });
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });

  it("cancels unsupported MCP forms without failing the model turn", async () => {
    const callback = vi.fn().mockResolvedValue({ behavior: "allow" });
    const h = await boot(callback);
    try {
      h.request({ threadId: question.threadId, serverName: "fixture", mode: "url", message: "Authenticate", url: "https://example.com/login", elicitationId: "auth-1" }, "mcpServer/elicitation/request");
      await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result).toEqual({ action: "cancel" }); expect(callback).not.toHaveBeenCalled();
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("retires %s on process replacement and ignores late approval", async (method) => {
    let answer!: (decision: EngineApprovalDecision) => void;
    let signal: AbortSignal | undefined;
    const callback = vi.fn((request: EngineApprovalRequest) => { signal = request.abortSignal; return new Promise<EngineApprovalDecision>((resolve) => { answer = resolve; }); });
    const h = await boot(callback);
    try {
      h.request({ threadId: question.threadId, turnId: question.turnId, command: "fixture-command" }, method);
      await waitFor(() => callback.mock.calls.length === 1);
      h.child.close(1);
      expect(signal?.aborted).toBe(true);
      const replacement = new FakeChildProcess();
      (h.adapter as unknown as { child: FakeChildProcess }).child = replacement;
      answer({ behavior: "allow", scope: "session" });
      await new Promise(resolve => setImmediate(resolve));
      expect(replacement.stdin.lines).toEqual([]);
      await h.turn.catch(() => undefined);
    } finally { h.adapter.destroy(); }
  });

  it.each(["abort", "resolved", "complete"])("cancels command approval on %s without accepting a late click", async (reason) => {
    let answer!: (decision: EngineApprovalDecision) => void;
    let signal: AbortSignal | undefined;
    const callback = vi.fn((request: EngineApprovalRequest) => { signal = request.abortSignal; return new Promise<EngineApprovalDecision>((resolve) => { answer = resolve; }); });
    const h = await boot(callback);
    try {
      h.request({ threadId: question.threadId, turnId: question.turnId }, "item/commandExecution/requestApproval");
      await waitFor(() => callback.mock.calls.length === 1);
      if (reason === "abort") h.controller.abort();
      else if (reason === "complete") h.finish();
      else h.child.stdout.emitData(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: question.threadId, requestId: "native-question" } }) + "\n");
      expect(signal?.aborted).toBe(true);
      answer({ behavior: "allow" });
      await new Promise(resolve => setImmediate(resolve));
      expect(h.responses()).toEqual(reason === "resolved" ? [] : [{ jsonrpc: "2.0", id: "native-question", result: { decision: "decline" } }]);
      if (reason === "resolved") h.finish();
      await h.turn.catch(() => undefined);
    } finally { h.adapter.destroy(); }
  });

  const permission = { threadId: question.threadId, turnId: question.turnId, itemId: "permission-item", cwd: "/workspace", startedAtMs: 123,
    permissions: { fileSystem: { read: ["/tmp/native-fixture"] }, network: { enabled: true } }, reason: "Read the fixture" };
  async function bootPermission(callback: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>, approvalMode = "normal") {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-permissions-"));
    const config = path.join(root, "config.json"); await writeFile(config, JSON.stringify({ approvalMode }));
    const h = await boot(callback, config);
    return { ...h, cleanup: async () => { h.adapter.destroy(); await removeTempRoot(root); } };
  }
  it.each(["once", "session", "deny"])("returns a native permission profile for %s without turning it into a command decision", async (choice) => {
    const callback = vi.fn().mockResolvedValue(choice === "deny" ? { behavior: "deny" } : { behavior: "allow", scope: choice });
    const h = await bootPermission(callback);
    try {
      h.request(permission, "item/permissions/requestApproval"); await waitFor(() => h.responses().length === 1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ toolName: "Codex additional permissions", cwd: permission.cwd,
        approvalScopes: { once: "turn", session: "session" }, abortSignal: expect.any(AbortSignal), toolInput: expect.objectContaining({ permissions: permission.permissions }) }));
      expect(h.responses()[0].result).toEqual({ permissions: choice === "deny" ? {} : permission.permissions, scope: choice === "session" ? "session" : "turn" });
      expect(h.onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: permission.itemId }));
      expect(h.onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_result", toolUseId: permission.itemId, isError: choice === "deny" }));
      h.finish(); await h.turn;
    } finally { await h.cleanup(); }
  });
  it.each(["bypass", "full-auto"])("does not silently grant unexpected native permissions in %s", async (mode) => {
    const callback = vi.fn().mockResolvedValue({ behavior: "allow" }), h = await bootPermission(callback, mode);
    try {
      h.request(permission, "item/permissions/requestApproval"); await waitFor(() => h.responses().length === 1);
      expect(callback).not.toHaveBeenCalled(); expect(h.responses()[0].result).toEqual({ permissions: {}, scope: "turn" });
      h.finish(); await h.turn;
    } finally { await h.cleanup(); }
  });
  it("keeps a sent native permission response settled if its progress renderer fails", async () => {
    const h = await bootPermission(async () => ({ behavior: "allow" }));
    h.onEngineEvent.mockImplementation((event) => { if (event.type === "tool_result") throw new Error("progress unavailable"); });
    try {
      h.request(permission, "item/permissions/requestApproval"); await waitFor(() => h.responses().length === 1);
      h.finish(); await expect(h.turn).resolves.toMatchObject({ text: "Done" });
      expect(h.responses()[0].result).toEqual({ permissions: permission.permissions, scope: "turn" });
    } finally { await h.cleanup(); }
  });
  it.each(["abort", "resolved", "complete", "child"])("retires native permission requests on %s and ignores late grants", async (reason) => {
    let answer!: (decision: EngineApprovalDecision) => void, signal: AbortSignal | undefined;
    const callback = vi.fn((request: EngineApprovalRequest) => { signal = request.abortSignal; return new Promise<EngineApprovalDecision>((resolve) => { answer = resolve; }); });
    const h = await bootPermission(callback);
    try {
      h.request(permission, "item/permissions/requestApproval"); await waitFor(() => callback.mock.calls.length === 1);
      if (reason === "abort") h.controller.abort();
      else if (reason === "complete") h.finish();
      else if (reason === "child") h.child.close(1);
      else h.child.stdout.emitData(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: permission.threadId, requestId: "native-question" } }) + "\n");
      await waitFor(() => signal!.aborted);
      answer({ behavior: "allow", scope: "session" }); await new Promise((resolve) => setImmediate(resolve));
      expect(h.responses()).toEqual(["abort", "complete"].includes(reason) ? [{ jsonrpc: "2.0", id: "native-question", result: { permissions: {}, scope: "turn" } }] : []);
      if (reason === "resolved") h.finish();
      await h.turn.catch(() => undefined);
    } finally { await h.cleanup(); }
  });
  it.each(["wrong-thread", "wrong-turn", "unknown-profile"])("denies %s permission requests without failing the turn", async (kind) => {
    const callback = vi.fn().mockResolvedValue({ behavior: "allow" }), h = await bootPermission(callback);
    try {
      h.request({ ...permission, ...(kind === "wrong-thread" ? { threadId: "other" } : kind === "wrong-turn" ? { turnId: "other" } : { permissions: { network: { enabled: true, unknownConstraint: true } } }) }, "item/permissions/requestApproval");
      await waitFor(() => h.responses().length === 1);
      expect(callback).not.toHaveBeenCalled(); expect(h.responses()[0].result).toEqual({ permissions: {}, scope: "turn" });
      h.finish(); await expect(h.turn).resolves.toMatchObject({ text: "Done" });
    } finally { await h.cleanup(); }
  });
});

function createAdapterWithWriterLockProbe(
  spawnFn: ReturnType<typeof createSpawnHarness>["spawnFn"] | (() => FakeChildProcess),
  findThreadWriterLockHolder: () => Promise<{
    pid: number;
    command?: string;
    isOwnChild: boolean;
    appLabel?: string;
  } | null>,
): CodexAppServerAdapter {
  return new CodexAppServerAdapter(
    "codex",
    process.cwd(),
    spawnFn,
    undefined,
    undefined,
    undefined,
    undefined,
    CODEX_APP_SERVER_TURN_TIMEOUT_MS,
    CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS,
    CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS,
    { findThreadWriterLockHolder },
  );
}

describe("CodexAppServerAdapter", () => {
  it.each([false, true])("captures native in-turn compaction and rejects foreign turns (throwing observer=%s)", async throwing => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const events: EngineStreamEvent[] = [];
    try {
      const result = adapter.sendUserMessage("tarobot-auto-compact", { text: "continue", files: [], onEngineEvent: event => {
        events.push(event); if (throwing && event.type === "context_compaction") throw new Error("observer failed");
      } });
      await waitFor(() => child.stdin.lines.length >= 1);
      const emit = (value: unknown) => child.stdout.emitData(JSON.stringify(value) + "\n");
      emit({ id: JSON.parse(child.stdin.lines[0]).id, result: { platformOs: "macos" } });
      await waitFor(() => child.stdin.lines.length >= 2);
      emit({ id: JSON.parse(child.stdin.lines[1]).id, result: { thread: { id: "native-compact" } } });
      await waitFor(() => child.stdin.lines.length >= 3);
      emit({ id: JSON.parse(child.stdin.lines[2]).id, result: { turn: { id: "turn-current" } } });
      // Let the turn/start response bind its native ID before delivering a
      // deliberately stale notification (the transport callback is async).
      await new Promise(resolve => setImmediate(resolve));
      const compact = (method: string, turnId = "turn-current") => emit({ method, params: { threadId: "native-compact", turnId, item: { type: "contextCompaction", id: "compact-item" } } });
      compact("item/started", "old-turn"); compact("item/completed", "old-turn");
      compact("item/started"); compact("item/completed");
      expect(events.filter(e => e.type === "context_compaction").map(e => [e.id, e.status])).toEqual([["compact-item", "started"], ["compact-item", "completed"]]);
      emit({ method: "item/agentMessage/delta", params: { threadId: "native-compact", turnId: "turn-current", delta: "continued" } });
      emit({ method: "turn/completed", params: { threadId: "native-compact", turn: { id: "turn-current", status: "completed", items: [], error: null } } });
      await expect(result).resolves.toMatchObject({ text: "continued" });
    } finally { await adapter.destroy(); }
  });
  it("allows active long-running turns up to six hours by default", () => {
    expect(CODEX_APP_SERVER_TURN_TIMEOUT_MS).toBe(6 * 60 * 60_000);
  });

  it("defaults the inactivity diagnostic interval to thirty minutes", () => {
    expect(CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it.each([false, true])("compacts a saturated thread before starting its next user turn (progress failure: %s)", async (progressFails) => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    expect(CODEX_APP_SERVER_AUTO_COMPACT_RATIO).toBe(0.8);
    expect(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS).toBeGreaterThan(0);

    const first = adapter.sendUserMessage("telegram-compact", { text: "first", files: [] });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-compact"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 3);
    const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-1"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-compact","turnId":"turn-1","delta":"first answer"}}\n');
    child.stdout.emitData('{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-compact","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":999999,"inputTokens":999999,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"last":{"totalTokens":212435,"inputTokens":211344,"cachedInputTokens":209280,"cacheWriteInputTokens":0,"outputTokens":1091,"reasoningOutputTokens":392},"modelContextWindow":258400}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(first).resolves.toMatchObject({ text: "first answer", sessionId: "thread-compact" });

    const onEngineEvent = vi.fn((event) => { if (progressFails && event.type === "context_compaction") throw new Error("progress unavailable"); });
    const second = adapter.sendUserMessage("thread-compact", { text: "second", files: [], onEngineEvent });
    await waitFor(() => child.stdin.lines.length >= 4);
    const compactStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(compactStart.method).toBe("thread/compact/start");
    expect(compactStart.params).toEqual({ threadId: "thread-compact" });
    expect(onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "context_compaction", status: "started", sessionId: "thread-compact" }));
    expect(child.stdin.lines.slice(3).map((line) => JSON.parse(line).method)).toEqual([
      "thread/compact/start",
    ]);
    child.stdout.emitData(`{"id":${compactStart.id},"result":{}}\n`);
    child.stdout.emitData('{"method":"turn/started","params":{"threadId":"thread-compact","turn":{"id":"turn-compact","items":[],"status":"inProgress","error":null}}}\n');
    child.stdout.emitData('{"method":"thread/compacted","params":{"threadId":"thread-compact","turnId":"turn-compact"}}\n');

    await waitFor(() => child.stdin.lines.length >= 5);
    const secondTurnStart = JSON.parse(child.stdin.lines[4] ?? "{}");
    expect(secondTurnStart.method).toBe("turn/start");
    const progress = onEngineEvent.mock.calls.map(([event]) => event).filter(event => event.type === "context_compaction");
    expect(progress.map(event => event.status)).toEqual(["started", "completed"]);
    expect(progress[1].id).toBe(progress[0].id);
    expect(secondTurnStart.params.threadId).toBe("thread-compact");
    child.stdout.emitData(`{"id":${secondTurnStart.id},"result":{"turn":{"id":"turn-2"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-compact","turnId":"turn-2","delta":"second answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toMatchObject({ text: "second answer" });
  });

  it("does not let the compaction turn's late turn/completed settle the next user turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("telegram-compact-race", { text: "first", files: [] });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-compact"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 3);
    const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-1"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-compact","turnId":"turn-1","delta":"first answer"}}\n');
    child.stdout.emitData('{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-compact","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":999999,"inputTokens":999999,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"last":{"totalTokens":212435,"inputTokens":211344,"cachedInputTokens":209280,"cacheWriteInputTokens":0,"outputTokens":1091,"reasoningOutputTokens":392},"modelContextWindow":258400}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(first).resolves.toMatchObject({ text: "first answer" });

    const second = adapter.sendUserMessage("thread-compact", { text: "second", files: [] });
    await waitFor(() => child.stdin.lines.length >= 4);
    const compactStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    child.stdout.emitData(`{"id":${compactStart.id},"result":{}}\n`);
    child.stdout.emitData('{"method":"turn/started","params":{"threadId":"thread-compact","turn":{"id":"turn-compact","items":[],"status":"inProgress","error":null}}}\n');
    child.stdout.emitData('{"method":"thread/compacted","params":{"threadId":"thread-compact","turnId":"turn-compact"}}\n');

    await waitFor(() => child.stdin.lines.length >= 5);
    const secondTurnStart = JSON.parse(child.stdin.lines[4] ?? "{}");
    expect(secondTurnStart.method).toBe("turn/start");

    // The compaction turn's own turn/completed can flush AFTER thread/compacted,
    // landing while the user's turn/start response is still in flight (its turn
    // id unregistered). Adopting that id settled the user's turn through the
    // empty-text thread/read fallback with the thread's PREVIOUS answer.
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-compact","items":[],"status":"completed","error":null}}}\n');
    const settledEarly = await Promise.race([
      second.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settledEarly).toBe(false);
    expect(child.stdin.lines.map((line) => JSON.parse(line).method ?? "")).not.toContain("thread/read");

    child.stdout.emitData(`{"id":${secondTurnStart.id},"result":{"turn":{"id":"turn-2"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-compact","turnId":"turn-2","delta":"second answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');
    await expect(second).resolves.toMatchObject({ text: "second answer" });
  });

  it("starts a fresh thread when preventive compaction is unavailable", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("telegram-compact-fallback", { text: "first", files: [] });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const firstThreadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${firstThreadStart.id},"result":{"thread":{"id":"thread-saturated"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 3);
    const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-1"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-saturated","turnId":"turn-1","delta":"first answer"}}\n');
    child.stdout.emitData('{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-saturated","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":999999,"inputTokens":999999,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"last":{"totalTokens":212435,"inputTokens":211344,"cachedInputTokens":209280,"cacheWriteInputTokens":0,"outputTokens":1091,"reasoningOutputTokens":392},"modelContextWindow":258400}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-saturated","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(first).resolves.toMatchObject({ sessionId: "thread-saturated" });

    const onEngineEvent = vi.fn();
    const second = adapter.sendUserMessage("thread-saturated", { text: "second", files: [], onEngineEvent });
    await waitFor(() => child.stdin.lines.length >= 4);
    const compactStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(compactStart.method).toBe("thread/compact/start");
    child.stdout.emitData(`{"id":${compactStart.id},"error":{"message":"method not found"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 5);
    const replacementThreadStart = JSON.parse(child.stdin.lines[4] ?? "{}");
    expect(replacementThreadStart.method).toBe("thread/start");
    expect(onEngineEvent.mock.calls.map(([event]) => event).filter(event => event.type === "context_compaction").map(event => event.status)).toEqual(["started", "failed"]);
    child.stdout.emitData(`{"id":${replacementThreadStart.id},"result":{"thread":{"id":"thread-fresh"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 6);
    const secondTurnStart = JSON.parse(child.stdin.lines[5] ?? "{}");
    expect(secondTurnStart.method).toBe("turn/start");
    expect(secondTurnStart.params.threadId).toBe("thread-fresh");
    child.stdout.emitData(`{"id":${secondTurnStart.id},"result":{"turn":{"id":"turn-2"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-fresh","turnId":"turn-2","delta":"fresh answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-fresh","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toMatchObject({ text: "fresh answer", sessionId: "thread-fresh" });
  });

  it("sets a Codex thread goal through the app-server protocol", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);

    const promise = adapter.setThreadGoal("telegram-12345", {
      objective: "ship the release",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    expect(threadStart.params.cwd).toBe("/tmp/project");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const goalSet = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(goalSet).toMatchObject({
      method: "thread/goal/set",
      params: {
        threadId: "thread-123",
        objective: "ship the release",
        tokenBudget: null,
      },
    });
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"ship the release","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}\n`);

    await expect(promise).resolves.toEqual({
      goal: {
        threadId: "thread-123",
        objective: "ship the release",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      sessionId: "thread-123",
    });
  });

  it("does not set a goal when stopped during native session publication", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
    const abort = new AbortController();
    const promise = adapter.watchThreadGoal("telegram-publish-stop", {
      objective: "must not start", abortSignal: abort.signal,
      onEngineEvent: async (event) => { if (event.type === "session") abort.abort(); },
    });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const start = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${start.id},"result":{"thread":{"id":"thread-stopped"}}}\n`);
    await expect(promise).resolves.toEqual({ goal: null, sessionId: "thread-stopped" });
    expect(child.stdin.lines.map((line) => JSON.parse(line).method)).not.toContain("thread/goal/set");
    adapter.destroy();
  });

  it("clears any existing goal before setting when watching, and resolves on the live status (not the stale set result)", async () => {
    // Regression: re-running /goal on a thread that already had a COMPLETE goal made
    // thread/goal/set return the stale "complete" status + old usage, so the watch
    // resolved instantly (e.g. a fresh "review the bugs" goal showing 432937 tokens as
    // done). watchThreadGoal must clear first so the new objective starts fresh.
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
    const onEngineEvent = vi.fn();

    const promise = adapter.watchThreadGoal("telegram-12345", {
      objective: "review the bugs",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
      onEngineEvent,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    // The fix: clear BEFORE set.
    await waitFor(() => child.stdin.lines.length >= 3);
    const goalClear = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(goalClear.method).toBe("thread/goal/clear");
    expect(onEngineEvent).toHaveBeenCalledWith({ type: "session", sessionId: "thread-123" });
    expect(goalClear.params).toMatchObject({ threadId: "thread-123" });
    child.stdout.emitData(`{"id":${goalClear.id},"result":{"cleared":true}}\n`);

    await waitFor(() => child.stdin.lines.length >= 4);
    const goalSet = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(goalSet).toMatchObject({
      method: "thread/goal/set",
      params: { threadId: "thread-123", objective: "review the bugs", tokenBudget: null },
    });
    // Set returns a fresh "active" goal (0 usage); the watch must NOT resolve on this.
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"review the bugs","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}\n`);

    child.stdout.emitData(JSON.stringify({ method: "item/started", params: { threadId: "thread-123", item: { id: "command-live", type: "commandExecution", command: "echo hi" } } }) + "\n");
    expect(onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_use", toolUseId: "command-live", toolInput: { command: "echo hi" } }));
    child.stdout.emitData(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-123", itemId: "command-live", delta: "hi" } }) + "\n");
    expect(onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_progress", toolUseId: "command-live", text: "hi" }));
    child.stdout.emitData(JSON.stringify({ method: "item/completed", params: { threadId: "thread-123", item: { id: "command-live", type: "commandExecution", command: "echo hi", aggregatedOutput: "hi", exitCode: 0, durationMs: 100 } } }) + "\n");
    expect(onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_result", toolUseId: "command-live", output: "hi", exitCode: 0, durationMs: 100 }));

    // It resolves only when Codex's autonomous pursuit actually reaches complete.
    child.stdout.emitData(`{"method":"thread/goal/updated","params":{"threadId":"thread-123","goal":{"threadId":"thread-123","objective":"review the bugs","status":"complete","tokenBudget":null,"tokensUsed":1234,"timeUsedSeconds":56,"createdAt":1,"updatedAt":2}}}\n`);

    const result = await promise;
    expect(result.goal?.status).toBe("complete");
    expect(result.goal?.tokensUsed).toBe(1234);
  });

  it("resolves goal watchers with the latest goal when the app-server child exits", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);

    const promise = adapter.watchThreadGoal("telegram-12345", {
      objective: "keep shipping",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
      onEngineEvent: () => {},
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const goalClear = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${goalClear.id},"result":{"cleared":true}}\n`);

    await waitFor(() => child.stdin.lines.length >= 4);
    const goalSet = JSON.parse(child.stdin.lines[3] ?? "{}");
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"keep shipping","status":"active","tokenBudget":null,"tokensUsed":7,"timeUsedSeconds":2,"createdAt":1,"updatedAt":1}}}\n`);

    child.close(1);

    await expect(Promise.race([
      promise.then((result) => result.goal?.status ?? "missing-goal"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ])).resolves.toBe("active");
  });

  it.each([false, true])("disarms an aborted goal without interrupting ordinary work (goal turn already ended: %s)", async (goalTurnEnded) => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
    const abort = new AbortController();
    const watch = adapter.watchThreadGoal("telegram-goal-stop", { objective: "write a long story", abortSignal: abort.signal });
    const frames = () => child.stdin.lines.map((line) => JSON.parse(line));
    const respond = async (method: string, result: unknown) => {
      await waitFor(() => frames().some((frame) => frame.method === method));
      const frame = frames().reverse().find((frame) => frame.method === method)!;
      child.stdout.emitData(JSON.stringify({ id: frame.id, result }) + "\n");
    };
    await respond("initialize", { platformOs: "macos" });
    await respond("thread/start", { thread: { id: "thread-stop-goal" } });
    await respond("thread/goal/clear", { cleared: false });
    await respond("thread/goal/set", { goal: { threadId: "thread-stop-goal", objective: "write a long story", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
    child.stdout.emitData(JSON.stringify({ method: "turn/started", params: { threadId: "thread-stop-goal", turn: { id: "autonomous-turn" } } }) + "\n");

    // Ordinary work shares the thread but owns a different native turn. Its
    // turn/started must never replace the goal's cancellation target.
    const ordinary = adapter.sendUserMessage("thread-stop-goal", { text: "ordinary question", files: [] });
    await respond("turn/start", { turn: { id: "ordinary-turn" } });
    child.stdout.emitData(JSON.stringify({ method: "turn/started", params: { threadId: "thread-stop-goal", turn: { id: "ordinary-turn" } } }) + "\n");
    if (goalTurnEnded) child.stdout.emitData(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-stop-goal", turn: { id: "autonomous-turn", status: "completed" } } }) + "\n");
    abort.abort();
    await waitFor(() => frames().filter((f) => f.method === "thread/goal/clear").length === 2);
    expect(frames().filter((f) => f.method === "turn/interrupt")).toHaveLength(0);
    await respond("thread/goal/clear", { cleared: true });
    await watch;
    const interrupts = frames().filter((f) => f.method === "turn/interrupt");
    expect(interrupts).toHaveLength(goalTurnEnded ? 0 : 1);
    if (!goalTurnEnded) {
      expect(interrupts[0].params).toEqual({ threadId: "thread-stop-goal", turnId: "autonomous-turn" });
      child.stdout.emitData(JSON.stringify({ id: interrupts[0].id, result: {} }) + "\n");
    }
    child.stdout.emitData(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-stop-goal", turn: { id: "autonomous-turn", status: "interrupted" } } }) + "\n");
    child.stdout.emitData(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-stop-goal", turn: { id: "ordinary-turn", status: "completed", items: [{ type: "agentMessage", text: "ordinary answer" }] } } }) + "\n");
    expect((await ordinary).text).toBe("ordinary answer");
    adapter.destroy();
  });

  it("does not start a goal stopped during its initial clear", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
    const abort = new AbortController();
    const watch = adapter.watchThreadGoal("telegram-stop-before-set", { objective: "must not start", abortSignal: abort.signal });
    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData(JSON.stringify({ id: JSON.parse(child.stdin.lines[0]!).id, result: {} }) + "\n");
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData(JSON.stringify({ id: JSON.parse(child.stdin.lines[1]!).id, result: { thread: { id: "thread-startup-stop" } } }) + "\n");
    await waitFor(() => child.stdin.lines.length >= 3);
    abort.abort();
    child.stdout.emitData(JSON.stringify({ id: JSON.parse(child.stdin.lines[2]!).id, result: { cleared: false } }) + "\n");
    await watch;
    expect(child.stdin.lines.map((line) => JSON.parse(line).method)).not.toContain("thread/goal/set");
    expect(child.stdin.lines.map((line) => JSON.parse(line).method)).not.toContain("turn/interrupt");
    adapter.destroy();
  });

  it("replays buffered goal start and completion after the ordinary turn gets its id", async () => {
    const f = await goalFixture();
    try {
      const ordinary = f.adapter.sendUserMessage(f.goal.threadId, { text: "ordinary", files: [] });
      await waitFor(() => f.frames().some((r) => r.method === "turn/start"));
      f.emit("turn/started", { turn: { id: "autonomous" } });
      f.emit("turn/completed", { turn: { id: "autonomous", status: "completed", items: [{ type: "agentMessage", text: "goal final" }] } });
      await f.respond("turn/start", { turn: { id: "ordinary" } });
      await Promise.resolve();
      f.emit("thread/goal/updated", { goal: { ...f.goal, status: "complete" } });
      expect((await f.watch).goal?.status).toBe("complete");
      expect(f.events).toContainEqual({ type: "result", text: "goal final", sessionId: f.goal.threadId });
      f.emit("turn/completed", { turn: { id: "ordinary", status: "completed", items: [{ type: "agentMessage", text: "ordinary final" }] } });
      expect((await ordinary).text).toBe("ordinary final");
    } finally { f.adapter.destroy(); }
  });

  it("never adopts a retired goal id while the next ordinary turn waits for its id", async () => {
    const f = await goalFixture();
    try {
      f.emit("turn/started", { turn: { id: "retired-goal" } });
      const ordinary = f.adapter.sendUserMessage(f.goal.threadId, { text: "ordinary", files: [] });
      await waitFor(() => f.frames().some((r) => r.method === "turn/start"));
      f.abort.abort(); await f.respond("thread/goal/clear", { cleared: true }, 2); await f.watch;
      f.emit("item/agentMessage/delta", { turnId: "retired-goal", delta: "wrong answer" });
      f.emit("turn/completed", { turn: { id: "retired-goal", status: "interrupted", items: [{ type: "agentMessage", text: "wrong answer" }] } });
      await f.respond("turn/start", { turn: { id: "ordinary" } });
      f.emit("turn/completed", { turn: { id: "ordinary", status: "completed", items: [{ type: "agentMessage", text: "right answer" }] } });
      expect((await ordinary).text).toBe("right answer");
    } finally { f.adapter.destroy(); }
  });

  it("does not reclassify an aborted unidentified ordinary turn as goal work", async () => {
    const f = await goalFixture();
    try {
      f.emit("turn/started", { turn: { id: "real-goal" } });
      const abort = new AbortController(), ordinary = f.adapter.sendUserMessage(f.goal.threadId, { text: "ordinary", files: [], abortSignal: abort.signal });
      const rejected = expect(ordinary).rejects.toThrow("aborted");
      await waitFor(() => f.frames().some((r) => r.method === "turn/start"));
      abort.abort(); await rejected;
      f.emit("turn/started", { turn: { id: "aborted-ordinary" } });
      f.emit("item/agentMessage/delta", { turnId: "aborted-ordinary", delta: "must not enter goal" });
      await f.respond("turn/start", { turn: { id: "aborted-ordinary" } });
      f.abort.abort();
      // Ordinary abort invalidates the loaded-thread cache; native cleanup
      // resumes that same thread before its clear RPC.
      await f.respond("thread/resume", { thread: { id: f.goal.threadId } });
      await f.respond("thread/goal/clear", { cleared: true }, 2); await f.watch;
      expect(f.frames().filter((r) => r.method === "turn/interrupt").map((r) => r.params.turnId)).toEqual(["aborted-ordinary", "real-goal"]);
      expect(JSON.stringify(f.events)).not.toContain("must not enter goal");
    } finally { f.adapter.destroy(); }
  });

  it("keeps a final answer streaming beyond one minute while its owned turn is active", async () => {
    const f = await goalFixture();
    f.emit("turn/started", { turn: { id: "long-final" } });
    vi.useFakeTimers();
    try {
      f.emit("thread/goal/updated", { goal: { ...f.goal, status: "complete" } });
      await vi.advanceTimersByTimeAsync(40_000);
      f.emit("item/agentMessage/delta", { turnId: "long-final", delta: "still writing" });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(f.frames().filter((r) => r.method === "turn/interrupt")).toHaveLength(0);
      f.emit("turn/completed", { turn: { id: "long-final", status: "completed", items: [{ type: "agentMessage", text: "finished answer" }] } });
      expect((await f.watch).goal?.status).toBe("complete");
    } finally { f.adapter.destroy(); vi.useRealTimers(); }
  });

  it.each([false, true])("retains a completed goal's final native turn, with bounded failure (missing end: %s)", async (missingEnd) => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
    const onEngineEvent = vi.fn();
    const watch = adapter.watchThreadGoal("telegram-final-goal", { objective: "compute", onEngineEvent });
    const frames = () => child.stdin.lines.map((line) => JSON.parse(line));
    const respond = async (method: string, result: unknown) => {
      await waitFor(() => frames().some((f) => f.method === method));
      child.stdout.emitData(JSON.stringify({ id: frames().find((f) => f.method === method).id, result }) + "\n");
    };
    await respond("initialize", {});
    await respond("thread/start", { thread: { id: "thread-final-goal" } });
    await respond("thread/goal/clear", { cleared: false });
    const goal = { threadId: "thread-final-goal", objective: "compute", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    await respond("thread/goal/set", { goal });
    child.stdout.emitData(JSON.stringify({ method: "turn/started", params: { threadId: goal.threadId, turn: { id: "goal-final-turn" } } }) + "\n");
    let settled = false; void watch.then(() => { settled = true; }, () => { settled = true; });
    if (missingEnd) vi.useFakeTimers();
    try {
      child.stdout.emitData(JSON.stringify({ method: "thread/goal/updated", params: { threadId: goal.threadId, goal: { ...goal, status: "complete" } } }) + "\n");
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      if (missingEnd) {
        const failure = expect(watch).rejects.toThrow("final native turn did not finish");
        await vi.advanceTimersByTimeAsync(CODEX_GOAL_FINAL_TURN_TIMEOUT_MS);
        await failure;
        expect(frames().find((f) => f.method === "turn/interrupt")?.params).toEqual({ threadId: goal.threadId, turnId: "goal-final-turn" });
      } else {
        child.stdout.emitData(JSON.stringify({ method: "turn/completed", params: { threadId: goal.threadId, turn: { id: "goal-final-turn", status: "completed", items: [{ type: "agentMessage", text: "SUM:456" }] } } }) + "\n");
        expect((await watch).goal?.status).toBe("complete");
        expect(onEngineEvent).toHaveBeenCalledWith({ type: "result", text: "SUM:456", sessionId: goal.threadId });
        expect(frames().filter((f) => f.method === "turn/interrupt")).toHaveLength(0);
      }
    } finally { adapter.destroy(); if (missingEnd) vi.useRealTimers(); }
  });

  it("times out a wedged goal RPC instead of leaving the watcher permanently busy", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnFn } = createSpawnHarness();
      const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
      const promise = adapter.watchThreadGoal("telegram-12345", {
        objective: "bounded goal rpc",
        workspaceOverride: "/tmp/project",
      });

      await vi.advanceTimersByTimeAsync(0);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-goal-timeout"}}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(child.stdin.lines[2] ?? "{}").method).toBe("thread/goal/clear");

      const assertion = expect(promise).rejects.toThrow(/thread\/goal\/set|not running/);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
      expect(child.killCalls).toBe(1);
      expect((adapter as unknown as { isIdle(): boolean }).isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and destroys app-server when initialize never replies", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnFn } = createSpawnHarness();
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.lines).toHaveLength(1);
      expect(JSON.parse(child.stdin.lines[0] ?? "{}").method).toBe("initialize");

      const assertion = expect(promise).rejects.toThrow("Codex app-server initialize timed out");
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS);
      await assertion;
      expect(child.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores late stdout from a retired app-server before its replacement starts", async () => {
    vi.useFakeTimers();
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const children = [childA, childB];
    const spawnFn = () => {
      const child = children.shift();
      if (!child) {
        throw new Error("no more fake children");
      }
      return child;
    };
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

    try {
      const firstInitialize = adapter.validateExternalSession("telegram-first");
      await vi.advanceTimersByTimeAsync(0);
      const initializeA = JSON.parse(childA.stdin.lines[0] ?? "{}");
      childA.stdout.emitData(`{"id":${initializeA.id},"result":{"platformOs":"macos"}}\n`);
      await expect(firstInitialize).resolves.toBeUndefined();

      adapter.destroy();
      childA.stdout.emitData("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB");

      const secondInitialize = adapter.validateExternalSession("telegram-second");
      const assertion = expect(secondInitialize).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      const initializeB = JSON.parse(childB.stdin.lines[0] ?? "{}");
      childB.stdout.emitData(`{"id":${initializeB.id},"result":{"platformOs":"macos"}}\n`);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS);

      await assertion;
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("times out and destroys app-server when thread/start never replies", async () => {
    vi.useFakeTimers();
    try {
      const childA = new FakeChildProcess();
      const childB = new FakeChildProcess();
      const children = [childA, childB];
      const spawnFn = () => {
        const child = children.shift();
        if (!child) {
          throw new Error("no more fake children");
        }
        return child;
      };
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      childA.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.stdin.lines).toHaveLength(2);
      expect(JSON.parse(childA.stdin.lines[1] ?? "{}").method).toBe("thread/start");

      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.killCalls).toBe(1);
      const retryInitialize = JSON.parse(childB.stdin.lines[0] ?? "{}");
      expect(retryInitialize.method).toBe("initialize");
      childB.stdout.emitData(`{"id":${retryInitialize.id},"result":{"platformOs":"windows"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childB.stdin.lines[1] ?? "{}").method).toBe("thread/start");

      const assertion = expect(promise).rejects.toMatchObject({
        name: "ThreadReadTimeoutError",
        message: expect.stringContaining("Codex app-server thread/start timed out"),
      });
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await assertion;
      expect(childB.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries thread/start once on a fresh app-server after a read timeout", async () => {
    vi.useFakeTimers();
    try {
      const childA = new FakeChildProcess();
      const childB = new FakeChildProcess();
      const children = [childA, childB];
      const spawnFn = () => {
        const child = children.shift();
        if (!child) {
          throw new Error("no more fake children");
        }
        return child;
      };
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      childA.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childA.stdin.lines[1] ?? "{}").method).toBe("thread/start");

      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.killCalls).toBe(1);
      const retryInitialize = JSON.parse(childB.stdin.lines[0] ?? "{}");
      expect(retryInitialize.method).toBe("initialize");

      childB.stdout.emitData(`{"id":${retryInitialize.id},"result":{"platformOs":"windows"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      const retryThreadStart = JSON.parse(childB.stdin.lines[1] ?? "{}");
      childB.stdout.emitData(`{"id":${retryThreadStart.id},"result":{"thread":{"id":"thread-retry"}}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childB.stdin.lines[2] ?? "{}").method).toBe("turn/start");
      childB.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-retry","item":{"type":"agentMessage","text":"ok after retry"}}}\n');
      childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-retry","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

      await expect(promise).resolves.toEqual({
        text: "ok after retry",
        sessionId: "thread-retry",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("overrides approval policy when resuming and starting a turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("thread-existing", {
      text: "Hello",
      files: [],
      onEngineEvent,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "thread-existing",
        approvalPolicy: "never",
        excludeTurns: true,
      },
    });
    child.stdout.emitData(`{"id":${resume.id},"result":{"thread":{"id":"thread-existing"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-existing",
        approvalPolicy: "on-request",
      },
    });
    child.stdout.emitData(`{"id":${turnStart.id},"result":{"turn":{"id":"turn-1"}}}\n`);
    child.stdout.emitData('{"jsonrpc":"2.0","id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-existing","turnId":"turn-1","itemId":"item-1","command":"outside workspace","cwd":"/tmp"}}\n');
    await waitFor(() => child.stdin.lines.some(line => JSON.parse(line).id === 99));
    expect(child.stdin.lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ id: 99, result: { decision: "decline" } }));
    expect(onEngineEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "permission_request" }));
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-existing","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-existing","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({
      text: "ok",
    });
  });

  it.each(["normal", "full-auto", "bypass"])("overrides saved thread sandbox and approval policy when resuming in %s", async (mode) => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-resume-permissions-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ approvalMode: mode }));
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);
    try {

      const promise = adapter.sendUserMessage("thread-existing", {
        text: "Hello",
        files: [],
        onApprovalRequest: vi.fn().mockResolvedValue({ behavior: "deny" }),
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

      await waitFor(() => child.stdin.lines.length >= 2);
      const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
      expect(resume).toMatchObject({
        method: "thread/resume",
        params: {
          threadId: "thread-existing",
          approvalPolicy: "never",
          excludeTurns: true,
          sandbox: mode === "bypass" ? "danger-full-access" : "workspace-write",
        },
      });
      child.stdout.emitData(`{"id":${resume.id},"result":{"thread":{"id":"thread-existing"}}}\n`);

      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: {
          threadId: "thread-existing",
          approvalPolicy: mode === "normal" ? "on-request" : "never",
          sandboxPolicy: { type: mode === "bypass" ? "dangerFullAccess" : "workspaceWrite" },
        },
      });
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-existing","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-existing","turn":{"id":"turn-1","status":"completed"}}}\n');

      await expect(promise).resolves.toMatchObject({
        text: "ok",
      });
    } finally { adapter.destroy(); await removeTempRoot(root); }
  });

  it("responds to app-server command approval requests instead of leaving the turn hanging", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const onEngineEvent = vi.fn();
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
    // Approvals are only forwarded in "normal" mode; this test exercises that flow,
    // so the instance is configured normal (the default is bypass → policy "never").
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      onApprovalRequest, onEngineEvent,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-123",
        approvalPolicy: "on-request",
      },
    });
    child.stdout.emitData('{"jsonrpc":"2.0","id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-123","turnId":"turn-1","itemId":"item-1","startedAtMs":1,"command":"tmux new-session","cwd":"/tmp/project","reason":"requires unsandboxed command"}}\n');

    await waitFor(() => child.stdin.lines.length >= 4);
    const approvalResponse = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(approvalResponse).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: {
        decision: "acceptForSession",
      },
    });
    expect(onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "permission_request", toolUseId: "item-1" }));
    expect(onApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      engine: "codex",
      toolName: "Codex command approval",
      cwd: "/tmp/project",
      approvalScopes: { once: "once", session: "session" },
      sessionId: "thread-123",
    }));

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"approved ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({
      text: "approved ok",
    });
    await removeTempRoot(root);
  });

  it("declines app-server approval denials while allowing the turn to continue", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "deny" });
    // Forwarding (and thus this user-driven deny) only happens in "normal" mode.
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      onApprovalRequest,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"jsonrpc":"2.0","id":99,"method":"item/fileChange/requestApproval","params":{"threadId":"thread-123","turnId":"turn-1","itemId":"item-1","cwd":"/tmp/project","reason":"needs write access"}}\n');

    await waitFor(() => child.stdin.lines.length >= 4);
    expect(JSON.parse(child.stdin.lines[3] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: {
        decision: "decline",
      },
    });

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"declined ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({
      text: "declined ok",
    });
    expect(onApprovalRequest).toHaveBeenCalled();
    await removeTempRoot(root);
  });

  it("times out and destroys app-server when thread/resume never replies", async () => {
    vi.useFakeTimers();
    try {
      const childA = new FakeChildProcess();
      const childB = new FakeChildProcess();
      const children = [childA, childB];
      const spawnFn = () => {
        const child = children.shift();
        if (!child) {
          throw new Error("no more fake children");
        }
        return child;
      };
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

      const promise = adapter.sendUserMessage("thread-previous", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      childA.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.stdin.lines).toHaveLength(2);
      expect(JSON.parse(childA.stdin.lines[1] ?? "{}").method).toBe("thread/resume");

      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.killCalls).toBe(1);
      const retryInitialize = JSON.parse(childB.stdin.lines[0] ?? "{}");
      expect(retryInitialize.method).toBe("initialize");
      childB.stdout.emitData(`{"id":${retryInitialize.id},"result":{"platformOs":"windows"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childB.stdin.lines[1] ?? "{}").method).toBe("thread/resume");

      const assertion = expect(promise).rejects.toMatchObject({
        name: "ThreadReadTimeoutError",
        message: expect.stringContaining("Codex app-server thread/resume timed out"),
      });
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await assertion;
      expect(childB.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out waiting for idle app-server state", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as {
        pendingTurns: Map<string, unknown>;
        waitForIdle: () => Promise<void>;
      };
      adapter.pendingTurns.set("turn-1", {});

      const waitPromise = adapter.waitForIdle();
      const assertion = expect(waitPromise).rejects.toThrow(
        `Codex app-server did not become idle within ${CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats live goal watchers as non-idle app-server work", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as {
        goalWatchers: Map<string, unknown>;
        waitForIdle: () => Promise<void>;
      };
      adapter.goalWatchers.set("thread-goal", {});

      const waitPromise = adapter.waitForIdle();
      const assertion = expect(waitPromise).rejects.toThrow(
        `Codex app-server did not become idle within ${CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not compact underneath a live goal pursuit", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn) as unknown as {
      goalWatchers: Map<string, unknown>;
      threadContextUsage: Map<string, { totalTokens: number; modelContextWindow: number }>;
      prepareThreadForTurn: (threadId: string, cwd: string) => Promise<string>;
    };
    adapter.goalWatchers.set("thread-goal", {});
    adapter.threadContextUsage.set("thread-goal", {
      totalTokens: 240_000,
      modelContextWindow: 258_400,
    });

    await expect(adapter.prepareThreadForTurn("thread-goal", process.cwd())).resolves.toBe("thread-goal");
    expect(child.stdin.lines).toHaveLength(0);
  });

  it("creates a logical TaroBot session placeholder", async () => {
    const adapter = new CodexAppServerAdapter("codex", process.cwd());
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "tarobot-12345",
    });
  });

  it("inherits CODEX_HOME from the parent env so bots track the main CLI", async () => {
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-shared-test";
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as { childEnv: NodeJS.ProcessEnv };
      expect(adapter.childEnv.CODEX_HOME).toBe("/tmp/codex-shared-test");
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("starts a persistent thread for a logical session and returns the real thread id", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const progressUpdates: string[] = [];

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.txt"],
      onProgress: (text) => progressUpdates.push(text),
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    expect(initialize.method).toBe("initialize");
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-123");
    expect(turnStart.params.input).toEqual([
      {
        type: "text",
        text: "Hello\nAttachment: a.txt",
        text_elements: [],
      },
    ]);

    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-123","delta":"READY"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null,"usage":{"input_tokens":12,"output_tokens":5,"cached_input_tokens":2,"cost_usd":0.001}}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY",
      sessionId: "thread-123",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.001,
      },
    });
    expect(progressUpdates).toEqual(["READY"]);
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toEqual(["app-server"]);
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("decodes UTF-8 JSON correctly when a multibyte character crosses stdout chunks", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-utf8"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    const delta = Buffer.from('{"method":"item/agentMessage/delta","params":{"threadId":"thread-utf8","delta":"你好🙂"}}\n');
    const marker = delta.indexOf(Buffer.from("好"));
    child.stdout.emitData(delta.subarray(0, marker + 1));
    child.stdout.emitData(delta.subarray(marker + 1));
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-utf8","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({ text: "你好🙂", sessionId: "thread-utf8" });
  });

  it("processes the final JSON-RPC event when app-server exits without a newline", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-final"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-final","delta":"FINAL"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-final","turn":{"id":"turn-1","status":"completed"}}}');
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "FINAL", sessionId: "thread-final" });
  });

  it("loads instructions from agent.md and isolates CODEX_HOME", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const engineHomePath = path.join(root, "engine-home");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
        engineHomePath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toBe("[System Instructions]\nYou are isolated.\n[End Instructions]\nHello");
      expect(calls[0]?.options.env?.CODEX_HOME).toBe(engineHomePath);

      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await waitFor(() => child.stdin.lines.length >= 4);
      const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
      expect(threadRead.method).toBe("thread/read");
      child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"agentMessage","text":"READY isolated"}]}]}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it.each(["normal", "full-auto"])("starts app-server in workspace-write mode for %s instances", async (mode) => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: mode }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onApprovalRequest: vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" }),
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="workspace-write"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      expect(JSON.parse(child.stdin.lines[1]!).params.sandbox).toBe("workspace-write");
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      // full-auto opts out of approvals: even though onApprovalRequest was passed,
      // the turn runs with policy "never" (Codex won't prompt) — only "normal" mode
      // forwards approvals. The workspace-write sandbox still bounds what can run.
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: {
          approvalPolicy: mode === "normal" ? "on-request" : "never",
          sandboxPolicy: { type: "workspaceWrite" },
        },
      });
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("starts app-server in danger-full-access mode for bypass instances", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs bypass instances with approvalPolicy never even when onApprovalRequest is provided", async () => {
    // Operator report: a yolo/bypass Codex instance still prompted to approve `rm -rf`.
    // bypass = danger-full-access + no approvals, so the turn must use policy "never"
    // and ignore any onApprovalRequest (matching the Claude/Antigravity/process adapters,
    // which gate approval forwarding on `approvalMode === "normal"`).
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onApprovalRequest,
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await waitFor(() => child.stdin.lines.length >= 2);
      const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);
      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: { approvalPolicy: "never" },
      });

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');
      await promise;
      expect(onApprovalRequest).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses the turn's captured approval mode when starting an app-server turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
      const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);
      const internal = adapter as unknown as {
        currentApprovalMode: string;
        loadRuntimeOptions: () => Promise<unknown>;
      };
      const loadRuntimeOptions = internal.loadRuntimeOptions.bind(adapter);
      internal.loadRuntimeOptions = async () => {
        const runtimeOptions = await loadRuntimeOptions();
        internal.currentApprovalMode = "bypass";
        return runtimeOptions;
      };

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onApprovalRequest,
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await waitFor(() => child.stdin.lines.length >= 2);
      const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);
      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: { approvalPolicy: "on-request" },
      });

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("defaults configured app-server instances without approval mode to danger-full-access", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, "{}\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("forwards model, effort, and Codex fast mode into app-server startup config", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ model: "gpt-5.6-luna", effort: "max", codexServiceTier: "fast" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual([
        "app-server",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'model_reasoning_effort="max"',
        "-c",
        'model="gpt-5.6-luna"',
        "--enable",
        "fast_mode",
        "-c",
        'service_tier="fast"',
      ]);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("defers ordinary settings while busy but rejects tasks under stale permissions", async () => {
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const children = [childA, childB];
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = (command: string, args: string[]) => {
      calls.push({ command, args });
      const child = children.shift();
      if (!child) {
        throw new Error("no more fake children");
      }
      return child;
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn as never,
        undefined,
        undefined,
        configPath,
      );

      const firstPromise = adapter.sendUserMessage("telegram-100", {
        text: "First",
        files: [],
      });

      await waitFor(() => childA.stdin.lines.length >= 1);
      const initA = JSON.parse(childA.stdin.lines[0] ?? "{}");
      childA.stdout.emitData(`{"id":${initA.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 2);
      const startThreadA = JSON.parse(childA.stdin.lines[1] ?? "{}");
      childA.stdout.emitData(`{"id":${startThreadA.id},"result":{"thread":{"id":"thread-a"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 3);

      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      await expect(adapter.sendUserMessage("telegram-blocked", { text: "Must not run under old permissions", files: [] })).rejects.toThrow("approval mode changed while busy");
      expect(childA.stdin.lines).toHaveLength(3);
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal", effort: "low", model: "gpt-6-astra" }));
      const secondPromise = adapter.sendUserMessage("telegram-200", {
        text: "Second",
        files: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(1);
      expect(childA.killCalls).toBe(0);

      // Busy config changes are deferred immediately. The second chat keeps
      // running on the old child/config instead of waiting up to 30 seconds.
      await waitFor(() => childA.stdin.lines.length >= 4);
      const startThreadBOnOldConfig = JSON.parse(childA.stdin.lines[3] ?? "{}");
      childA.stdout.emitData(`{"id":${startThreadBOnOldConfig.id},"result":{"thread":{"id":"thread-b-old"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 5);
      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-b-old","item":{"type":"agentMessage","text":"second ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-b-old","turn":{"id":"turn-b","items":[],"status":"completed","error":null}}}\n');
      await expect(secondPromise).resolves.toEqual({
        text: "second ok",
        sessionId: "thread-b-old",
      });

      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-a","item":{"type":"agentMessage","text":"first ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","items":[],"status":"completed","error":null}}}\n');
      await expect(firstPromise).resolves.toEqual({
        text: "first ok",
        sessionId: "thread-a",
      });

      const thirdPromise = adapter.sendUserMessage("telegram-300", {
        text: "Third",
        files: [],
      });

      await waitFor(() => childB.stdin.lines.length >= 1);
      expect(childA.killCalls).toBe(1);
      expect(calls[1]?.args).toEqual(["app-server", "-c", 'sandbox_mode="workspace-write"', "-c", 'model_reasoning_effort="low"', "-c", 'model="gpt-6-astra"']);

      const initB = JSON.parse(childB.stdin.lines[0] ?? "{}");
      childB.stdout.emitData(`{"id":${initB.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 2);
      const startThreadC = JSON.parse(childB.stdin.lines[1] ?? "{}");
      childB.stdout.emitData(`{"id":${startThreadC.id},"result":{"thread":{"id":"thread-c"}}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 3);
      childB.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-c","item":{"type":"agentMessage","text":"third ok"}}}\n');
      childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-c","turn":{"id":"turn-c","items":[],"status":"completed","error":null}}}\n');

      await expect(thirdPromise).resolves.toEqual({
        text: "third ok",
        sessionId: "thread-c",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("sends a ticket model/effort on turn/start without restarting the shared app-server", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-app-server-override-"));
    const configPath = path.join(root, "config.json"), config = JSON.stringify({ approvalMode: "bypass", model: "gpt-5.6-luna", effort: "max" }) + "\n";
    await writeFile(configPath, config, "utf8");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);
    const sent = (method: string) => child.stdin.lines.map(line => JSON.parse(line)).filter(line => line.method === method);
    let initialized = false;
    const run = async (sessionId: string, threadId: string, engineOverride?: { model?: string; effort?: "ultra" }) => {
      const before = sent("turn/start").length;
      const promise = adapter.sendUserMessage(sessionId, { text: "Hello", files: [], ...(engineOverride ? { engineOverride } : {}) });
      if (!initialized) {
        await waitFor(() => child.stdin.lines.length >= 1);
        child.stdout.emitData(`{"id":${JSON.parse(child.stdin.lines[0]!).id},"result":{"platformOs":"macos"}}\n`);
        initialized = true;
      }
      await waitFor(() => sent("thread/start").length > before);
      child.stdout.emitData(`{"id":${sent("thread/start").at(-1).id},"result":{"thread":{"id":"${threadId}"}}}\n`);
      await waitFor(() => sent("turn/start").length > before);
      child.stdout.emitData(`{"method":"item/completed","params":{"threadId":"${threadId}","item":{"type":"agentMessage","text":"ok"}}}\n`);
      child.stdout.emitData(`{"method":"turn/completed","params":{"threadId":"${threadId}","turn":{"id":"turn-${threadId}","items":[],"status":"completed","error":null}}}\n`);
      await expect(promise).resolves.toMatchObject({ text: "ok" });
      return sent("turn/start").at(-1).params;
    };
    try {
      expect(await run("telegram-1", "thread-ticket", { model: "gpt-6-sol", effort: "ultra" })).toMatchObject({ threadId: "thread-ticket", model: "gpt-6-sol", effort: "ultra" });
      const ordinary = await run("telegram-2", "thread-plain");
      expect(ordinary).not.toHaveProperty("model");
      expect(ordinary).not.toHaveProperty("effort");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"', "-c", 'model_reasoning_effort="max"', "-c", 'model="gpt-5.6-luna"']);
      // turn/start cannot clear the child's max for one thread, so gpt-5.5 fails as engine-settings.
      const lines = child.stdin.lines.length;
      const rejected = adapter.sendUserMessage("telegram-3", { text: "Hello", files: [], engineOverride: { model: "gpt-5.5" } });
      await expect(rejected).rejects.toThrow('Invalid model selection: gpt-5.5 has no "max" effort');
      await expect(rejected.catch(error => classifyFailure(error))).resolves.toBe("engine-settings");
      expect(child.stdin.lines).toHaveLength(lines);
      expect(await readFile(configPath, "utf8")).toBe(config);
    } finally {
      await adapter.destroy();
      await removeTempRoot(root);
    }
  });

  it("blocks malformed config rather than launching with unsafe defaults", async () => {
    const { calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    const adapter = new CodexAppServerAdapter("codex", root, undefined, spawnFn, undefined, undefined, configPath);
    try {
      await writeFile(configPath, "{not-json\n", "utf8");
      await expect(adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] })).rejects.toThrow("execution blocked");
      expect(calls).toHaveLength(0);
    } finally {
      await adapter.destroy();
      await removeTempRoot(root);
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toContain("You are isolated.");
      expect(turnStart.params.input[0].text).toContain("[Telegram Bridge Capabilities]");

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("truncates oversized instructions and degrades safely on read failure", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "x".repeat(20_000), "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toContain("[Instructions truncated at 16000 characters]");
      expect(turnStart.params.input[0].text.length).toBeLessThan(17_000);

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;

      const secondHarness = createSpawnHarness();
      const second = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        secondHarness.spawnFn,
        path.join(root, "missing.md"),
      );
      const secondPromise = second.sendUserMessage("telegram-67890", {
        text: "Hello again",
        files: [],
      });
      await waitFor(() => secondHarness.child.stdin.lines.length >= 1);
      secondHarness.child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => secondHarness.child.stdin.lines.length >= 2);
      secondHarness.child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-456"}}}\n');
      await waitFor(() => secondHarness.child.stdin.lines.length >= 3);
      const secondTurnStart = JSON.parse(secondHarness.child.stdin.lines[2] ?? "{}");
      expect(secondTurnStart.params.input[0].text).toBe("Hello again");
      secondHarness.child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-456","item":{"type":"agentMessage","text":"ok"}}}\n');
      secondHarness.child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-456","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');
      await secondPromise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reuses an existing thread without starting a new one", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-abc", {
      text: "Next",
      files: [],
      instructions: "Be concise.",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume.method).toBe("thread/resume");
    expect(resume.params.threadId).toBe("thread-abc");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-abc");
    expect(turnStart.params.input[0].text).toBe("[System Instructions]\nBe concise.\n[End Instructions]\nNext");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "done",
    });
  });

  it("does not resume a thread twice once it is loaded", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("thread-abc", {
      text: "First",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-1"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await first;

    const second = adapter.sendUserMessage("thread-abc", {
      text: "Second",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 4);
    const nextRequest = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(nextRequest.method).toBe("turn/start");
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-2"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toEqual({
      text: "done-2",
    });
  });

  it("falls back to thread/read when turn completion arrives before agent text events", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","usage":{"inputTokens":9,"outputTokens":4,"cachedTokens":1},"items":[{"type":"agentMessage","text":"READY via thread read"}]}]}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY via thread read",
      sessionId: "thread-123",
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        cachedTokens: 1,
      },
    });
  });

  it("uses turn/completed summary items without issuing a redundant thread/read", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const imagePath = "/tmp/codex-generated/summary.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData(JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-123",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          usage: { inputTokens: 5, outputTokens: 2, cachedTokens: 1 },
          itemsView: "summary",
          items: [
            { type: "agentMessage", text: "READY from completion summary" },
            { type: "imageGenerationCall", result: { saved_path: imagePath } },
          ],
        },
      },
    }) + "\n");

    await expect(promise).resolves.toEqual({
      text: `READY from completion summary\n[send-image:${imagePath}]`,
      sessionId: "thread-123",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cachedTokens: 1,
      },
    });
    expect(child.stdin.lines).toHaveLength(3);
  });

  it("emits generated image items as send-image stream output", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const engineEvents: unknown[] = [];
    const imagePath = "/tmp/codex-generated/photo.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "make image fun",
      files: [],
      onEngineEvent: (event) => {
        engineEvents.push(event);
      },
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-123",
        item: {
          type: "imageGenerationCall",
          result: {
            saved_path: imagePath,
          },
        },
      },
    }) + "\n");
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: `[send-image:${imagePath}]`,
      sessionId: "thread-123",
    });
    expect(engineEvents).toEqual([
      // The thread is announced before the turn starts so the bridge binds it
      // even if the turn is aborted (see engine-audit3-fixes).
      {
        type: "session",
        sessionId: "thread-123",
      },
      {
        type: "assistant_text",
        text: `[send-image:${imagePath}]`,
        sessionId: "thread-123",
      },
    ]);
  });

  it("emits Codex async user-input questions without replacing the final answer", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const engineEvents: unknown[] = [];

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "prepare the post",
      files: [],
      onEngineEvent: (event) => {
        engineEvents.push(event);
      },
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-123",
        item: {
          id: "question-1",
          type: "agentMessage",
          text: "Which style should I use?\n- Hand-drawn\n- Watercolor",
          delivery: "async",
          questions: [{
            title: "Which style should I use?",
            options: ["Hand-drawn", "Watercolor"],
          }],
        },
      },
    }) + "\n");
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"Draft preparation continues."}}}\n');
    child.stdout.emitData(JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-123",
        turn: {
          id: "turn-1",
          items: [
            { type: "agentMessage", text: "Draft preparation continues." },
            {
              id: "question-1",
              type: "agentMessage",
              text: "Which style should I use?",
              delivery: "async",
              questions: [{ title: "Which style should I use?", options: ["Hand-drawn", "Watercolor"] }],
            },
          ],
          status: "completed",
          error: null,
        },
      },
    }) + "\n");

    await expect(promise).resolves.toMatchObject({
      text: "Draft preparation continues.",
      sessionId: "thread-123",
    });
    expect(engineEvents).toContainEqual({
      type: "user_input_request",
      toolName: "request_user_input_async",
      toolInput: {
        questions: [{
          title: "Which style should I use?",
          options: ["Hand-drawn", "Watercolor"],
        }],
      },
      requestId: "question-1",
      sessionId: "thread-123",
    });
  });

  it("recovers generated image paths from thread/read without resending input attachments", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const sourcePath = "/tmp/telegram-input/original.jpg";
    const generatedPath = "/tmp/codex-generated/fun.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "make image fun",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData(JSON.stringify({
      id: 4,
      result: {
        thread: {
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "input_image", path: sourcePath }],
                },
                {
                  type: "imageGenerationCall",
                  result: { saved_path: generatedPath },
                },
              ],
            },
          ],
        },
      },
    }) + "\n");

    await expect(promise).resolves.toEqual({
      text: `[send-image:${generatedPath}]`,
      sessionId: "thread-123",
    });
  });

  it("does not duplicate generated image tags recovered from thread/read", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const generatedPath = "/tmp/codex-generated/fun.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "make image fun",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    child.stdout.emitData(JSON.stringify({
      id: 4,
      result: {
        thread: {
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "agentMessage",
                  text: `Done.\n[send-image:${generatedPath}]`,
                },
                {
                  type: "imageGenerationCall",
                  result: { saved_path: generatedPath },
                },
              ],
            },
          ],
        },
      },
    }) + "\n");

    await expect(promise).resolves.toEqual({
      text: `Done.\n[send-image:${generatedPath}]`,
      sessionId: "thread-123",
    });
  });

  it("rejects with the turn error instead of resolving a fake completion message", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"error","params":{"error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null},"willRetry":false,"threadId":"thread-123","turnId":"turn-1"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"failed","error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null}}}}\n');

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("preserves the structured Codex error code on failed turns", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"failed","error":{"message":"Quota exceeded.","codexErrorInfo":"usageLimitExceeded","additionalDetails":null}}}}\n');

    await expect(promise).rejects.toThrow("Quota exceeded.\nCodex error code: usageLimitExceeded");
  });

  it("does not let a recovered transport error override a completed turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Download the video",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"error","params":{"error":{"message":"Reconnecting... waiting for network"},"willRetry":true,"threadId":"thread-123","turnId":"turn-1"}}\n');
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","turnId":"turn-1","item":{"type":"agentMessage","text":"Downloaded and verified."}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "Downloaded and verified.",
      sessionId: "thread-123",
    });
  });

  it("uses the preceding error notification when a failed turn has no error detail", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"error","params":{"error":{"message":"upstream connection failed"},"willRetry":false,"threadId":"thread-123","turnId":"turn-1"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"failed","error":null}}}\n');

    await expect(promise).rejects.toThrow("upstream connection failed");
  });

  it("aborts an in-flight turn when the caller aborts the request", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    controller.abort();

    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    expect(child.killCalls).toBe(0);
  });

  it("interrupts a turn aborted before its turn id arrived (writer-leak fix)", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");

    // Abort BEFORE the turn/start response delivers the turn id: the interrupt
    // has no addressable turn yet.
    controller.abort();
    await expect(promise).rejects.toThrow("Codex app-server turn aborted");

    // The app-server started the turn anyway. Its late response must trigger
    // the deferred interrupt, or the server-side turn keeps the thread's
    // writer and every later turn fails with "already has an active writer".
    child.stdout.emitData(`{"id":${turnStart.id},"result":{"turn":{"id":"turn-late"}}}\n`);
    await waitFor(() => child.stdin.lines.some((line) => {
      const parsed = JSON.parse(line || "{}") as { method?: string; params?: { turnId?: string } };
      return parsed.method === "turn/interrupt" && parsed.params?.turnId === "turn-late";
    }));
    expect(child.killCalls).toBe(0);
  });

  it("does not overwrite an in-flight turn when the same thread is entered twice", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const internals = adapter as unknown as {
      threadContextUsage: Map<string, { totalTokens: number; modelContextWindow: number }>;
    };

    const first = adapter.sendUserMessage("telegram-overlap", {
      text: "first",
      files: [],
    });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-overlap"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 3);
    const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-first"}}}\n`);

    // A saturated context must not trigger compaction underneath the live turn.
    internals.threadContextUsage.set("thread-overlap", {
      totalTokens: 90,
      modelContextWindow: 100,
    });
    const controller = new AbortController();
    controller.abort();
    const second = adapter.sendUserMessage("thread-overlap", {
      text: "second",
      files: [],
      abortSignal: controller.signal,
    });
    await expect(Promise.race([
      second,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("second turn did not reject promptly")), 100);
      }),
    ])).rejects.toThrow("already has an in-flight turn");
    expect(child.stdin.lines.map((line) => JSON.parse(line).method).filter(Boolean)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
    ]);

    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-overlap","turnId":"turn-first","delta":"first answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-overlap","turn":{"id":"turn-first","items":[],"status":"completed","error":null}}}\n');
    await expect(first).resolves.toMatchObject({ text: "first answer" });
  });

  it("does not compact a thread while its first turn is still in asynchronous preparation", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const internals = adapter as unknown as {
      threadContextUsage: Map<string, { totalTokens: number; modelContextWindow: number }>;
      isIdle(): boolean;
    };
    let releaseSessionEvent!: () => void;
    const sessionEventGate = new Promise<void>((resolve) => {
      releaseSessionEvent = resolve;
    });
    let sessionEventStarted = false;

    const first = adapter.sendUserMessage("thread-preparing", {
      text: "first",
      files: [],
      onEngineEvent: async (event) => {
        if (event.type === "session") {
          sessionEventStarted = true;
          await sessionEventGate;
        }
      },
    });
    void first.catch(() => undefined);

    try {
      await waitFor(() => child.stdin.lines.length >= 1);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await waitFor(() => child.stdin.lines.length >= 2);
      const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${resume.id},"result":{"thread":{"id":"thread-preparing"}}}\n`);
      await waitFor(() => sessionEventStarted);
      expect(internals.isIdle()).toBe(false);
      expect(child.stdin.lines.map((line) => JSON.parse(line).method).filter(Boolean)).toEqual([
        "initialize",
        "thread/resume",
      ]);

      internals.threadContextUsage.set("thread-preparing", {
        totalTokens: 90,
        modelContextWindow: 100,
      });
      const second = adapter.sendUserMessage("thread-preparing", {
        text: "second",
        files: [],
      });
      await expect(Promise.race([
        second,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("second turn did not reject promptly")), 100);
        }),
      ])).rejects.toThrow("already has an in-flight turn");
      expect(child.stdin.lines.map((line) => JSON.parse(line).method).filter(Boolean)).toEqual([
        "initialize",
        "thread/resume",
      ]);

      releaseSessionEvent();
      await waitFor(() => child.stdin.lines.length >= 3);
      const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(firstTurnStart.method).toBe("turn/start");
      child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-first"}}}\n`);
      child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-preparing","turnId":"turn-first","delta":"first answer"}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-preparing","turn":{"id":"turn-first","items":[],"status":"completed","error":null}}}\n');
      await expect(first).resolves.toMatchObject({ text: "first answer" });
      expect(internals.isIdle()).toBe(true);
    } finally {
      releaseSessionEvent();
      await adapter.destroy();
    }
  });

  it("does not send an invalid turn/interrupt when another process owns the writer", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = createAdapterWithWriterLockProbe(spawnFn, async () => ({
      pid: 4242,
      command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      isOwnChild: false,
      appLabel: "ChatGPT desktop app",
    }));

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");

    child.stdout.emitData(`{"id":${turnStart.id},"error":{"code":-32603,"message":"thread thread-123 already has an active writer"}}\n`);
    await expect(promise).rejects.toThrow("ChatGPT desktop app");

    expect(child.stdin.lines.map((line) => JSON.parse(line).method).filter(Boolean)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
    ]);
    expect(child.killCalls).toBe(0);
  });

  it("restarts an idle app-server and retries once when its own child leaked the writer", async () => {
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const children = [childA, childB];
    const spawnFn = () => {
      const child = children.shift();
      if (!child) {
        throw new Error("no more fake children");
      }
      return child;
    };
    const adapter = createAdapterWithWriterLockProbe(spawnFn, async () => ({
      pid: 31337,
      command: "codex app-server",
      isOwnChild: true,
      appLabel: "this bot app-server",
    }));

    const promise = adapter.sendUserMessage("thread-owned-writer", {
      text: "recover me",
      files: [],
    });
    void promise.catch(() => undefined);

    await waitFor(() => childA.stdin.lines.length >= 1);
    const initializeA = JSON.parse(childA.stdin.lines[0] ?? "{}");
    childA.stdout.emitData(`{"id":${initializeA.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => childA.stdin.lines.length >= 2);
    const resumeA = JSON.parse(childA.stdin.lines[1] ?? "{}");
    expect(resumeA.method).toBe("thread/resume");
    childA.stdout.emitData(`{"id":${resumeA.id},"error":{"code":-32600,"message":"thread thread-owned-writer already has an active writer"}}\n`);

    await waitFor(() => childA.killCalls === 1 && childB.stdin.lines.length >= 1);
    expect(childA.stdin.lines.map((line) => JSON.parse(line).method).filter(Boolean)).toEqual([
      "initialize",
      "thread/resume",
    ]);

    const initializeB = JSON.parse(childB.stdin.lines[0] ?? "{}");
    childB.stdout.emitData(`{"id":${initializeB.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => childB.stdin.lines.length >= 2);
    const resumeB = JSON.parse(childB.stdin.lines[1] ?? "{}");
    expect(resumeB.method).toBe("thread/resume");
    childB.stdout.emitData(`{"id":${resumeB.id},"result":{"thread":{"id":"thread-owned-writer"}}}\n`);
    await waitFor(() => childB.stdin.lines.length >= 3);
    const turnStart = JSON.parse(childB.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    childB.stdout.emitData(`{"id":${turnStart.id},"result":{"turn":{"id":"turn-recovered"}}}\n`);
    childB.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-owned-writer","turnId":"turn-recovered","delta":"recovered"}}\n');
    childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-owned-writer","turn":{"id":"turn-recovered","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({ text: "recovered" });
  });

  it("defers recycling its own writer leak until other turns have completed", async () => {
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const children = [childA, childB];
    const spawnFn = () => {
      const child = children.shift();
      if (!child) {
        throw new Error("no more fake children");
      }
      return child;
    };
    const adapter = createAdapterWithWriterLockProbe(spawnFn, async () => ({
      pid: 31337,
      command: "codex app-server",
      isOwnChild: true,
      appLabel: "this bot app-server",
    }));

    const liveTurn = adapter.sendUserMessage("telegram-live", {
      text: "keep running",
      files: [],
    });
    await waitFor(() => childA.stdin.lines.length >= 1);
    childA.stdout.emitData('{"id":1,"result":{"platformOs":"macos"}}\n');
    await waitFor(() => childA.stdin.lines.length >= 2);
    childA.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-live"}}}\n');
    await waitFor(() => childA.stdin.lines.length >= 3);
    const liveTurnStart = JSON.parse(childA.stdin.lines[2] ?? "{}");
    childA.stdout.emitData(`{"id":${liveTurnStart.id},"result":{"turn":{"id":"turn-live"}}}\n`);

    const conflictedTurn = adapter.sendUserMessage("thread-own-lock-busy", {
      text: "conflict",
      files: [],
    });
    await waitFor(() => childA.stdin.lines.length >= 4);
    const resume = JSON.parse(childA.stdin.lines[3] ?? "{}");
    expect(resume.method).toBe("thread/resume");
    childA.stdout.emitData(`{"id":${resume.id},"error":{"code":-32600,"message":"thread thread-own-lock-busy already has an active writer"}}\n`);

    await expect(conflictedTurn).rejects.toThrow("本 bot 自己的引擎进程");
    expect(childA.killCalls).toBe(0);

    childA.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-live","turnId":"turn-live","delta":"live answer"}}\n');
    childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-live","turn":{"id":"turn-live","items":[],"status":"completed","error":null}}}\n');
    await expect(liveTurn).resolves.toMatchObject({ text: "live answer" });
    await waitFor(() => childA.killCalls === 1);
    expect(childB.stdin.lines).toHaveLength(0);
  });

  it("emits current Codex reasoning summary and raw-text deltas as thinking", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const engineEvents: Array<{ type: string; text?: string }> = [];

    const promise = adapter.sendUserMessage("telegram-reasoning", {
      text: "think",
      files: [],
      onEngineEvent: (event) => {
        engineEvents.push(event);
      },
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"macos"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-reasoning"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${turnStart.id},"result":{"turn":{"id":"turn-reasoning"}}}\n`);
    child.stdout.emitData('{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-reasoning","turnId":"turn-reasoning","itemId":"reasoning-1","summaryIndex":0,"delta":"Readable summary"}}\n');
    child.stdout.emitData('{"method":"item/reasoning/textDelta","params":{"threadId":"thread-reasoning","turnId":"turn-reasoning","itemId":"reasoning-2","contentIndex":0,"delta":"Raw reasoning"}}\n');
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-reasoning","turnId":"turn-reasoning","delta":"answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-reasoning","turn":{"id":"turn-reasoning","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toMatchObject({ text: "answer" });
    expect(engineEvents.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", text: "Readable summary", sessionId: "thread-reasoning" },
      { type: "thinking", text: "Raw reasoning", sessionId: "thread-reasoning" },
    ]);
  });

  it("rejects when thread/read shows the completed turn actually failed", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"userMessage","content":[{"type":"text","text":"Hello"}]}],"status":"failed","error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null}}]}}}\n');

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("times out an in-flight turn that never completes without killing the shared child", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow("Codex app-server turn timed out");
    // Thread-scoped (H4): the timed-out turn rejects, but the SHARED child is not
    // killed so other concurrent conversations keep running. A genuinely wedged
    // child is still caught by the next thread/resume|read request timeout.
    expect(child.killCalls).toBe(0);
  });

  it("aborts an idle app-server turn at the inactivity interval so queues can continue", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      25,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow("Codex app-server turn became inactive after 1 minutes");
    // Thread-scoped (H4): rejecting the inactive turn lets this conversation's
    // queue continue without killing the shared child / other live turns.
    expect(child.killCalls).toBe(0);
  });

  it("uses a dedicated thread/read timeout after turn/completed instead of the inactivity watchdog", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      60 * 60_000,
      1,
      5,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");

    await expect(promise).rejects.toThrow("Codex app-server thread/read timed out");
    expect(child.killCalls).toBe(1);
  });

  it("does not drive completingTurns negative when a completing turn is destroyed mid-read", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);

    (adapter as unknown as { destroy(): void }).destroy();
    await expect(promise).rejects.toThrow("Adapter destroyed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const internal = adapter as unknown as {
      completingTurns: number;
      waitForIdle(): Promise<void>;
    };
    expect(internal.completingTurns).toBe(0);
    await expect(internal.waitForIdle()).resolves.toBeUndefined();
  });

  it("does not destroy the shared child when aborting one chat turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn);
    const firstAbort = new AbortController();

    const firstPromise = adapter.sendUserMessage("telegram-100", {
      text: "First",
      files: [],
      abortSignal: firstAbort.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-a"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    const secondPromise = adapter.sendUserMessage("telegram-200", {
      text: "Second",
      files: [],
    });
    await waitFor(() => child.stdin.lines.length >= 4);
    const secondThreadStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(secondThreadStart.method).toBe("thread/start");
    child.stdout.emitData(`{"id":${secondThreadStart.id},"result":{"thread":{"id":"thread-b"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 5);

    firstAbort.abort();
    await expect(firstPromise).rejects.toThrow("Codex app-server turn aborted");
    expect(child.killCalls).toBe(0);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","items":[],"status":"completed","error":null}}}\n');
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-b","item":{"type":"agentMessage","text":"second ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-b","turn":{"id":"turn-b","items":[],"status":"completed","error":null}}}\n');

    await expect(secondPromise).resolves.toEqual({
      text: "second ok",
      sessionId: "thread-b",
    });
    expect(child.killCalls).toBe(0);
  });

  it("clears transport buffers and diagnostic tails on destroy", () => {
    const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as {
      lineBuffer: string;
      stderrTail: string;
      stdoutDiagnosticTail: string;
      destroy(): void;
    };
    adapter.lineBuffer = '{"partial":true';
    adapter.stderrTail = "trustd noise";
    adapter.stdoutDiagnosticTail = "non-json";

    adapter.destroy();

    expect(adapter.lineBuffer).toBe("");
    expect(adapter.stderrTail).toBe("");
    expect(adapter.stdoutDiagnosticTail).toBe("");
  });

  it("includes stderr and non-JSON stdout diagnostics in hard timeout failures after idle intervals", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      5,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stderr.emitData("trustd: ocsp responder failed\n");
    child.stdout.emitData("non-json diagnostic line\n");

    await expect(promise).rejects.toThrow(/trustd: ocsp responder failed/);
    await expect(promise).rejects.toThrow(/non-json diagnostic line/);
    // Thread-scoped (H4): the rejection still carries diagnostics, but the shared
    // child is not killed on a per-turn timeout.
    expect(child.killCalls).toBe(0);
  });

  it("includes app-server protocol state in hard timeout failures after idle intervals", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      5,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow(/\[app-server state\]/);
    await expect(promise).rejects.toThrow(/pending turn: threadId=thread-123/);
    await expect(promise).rejects.toThrow(/last request: .* id=3 method=turn\/start threadId=thread-123/);
    await expect(promise).rejects.toThrow(/last response: .* id=2 method=thread\/start threadId=thread-123/);
    await expect(promise).rejects.toThrow(/last notification: none/);
    await expect(promise).rejects.toThrow(/last turn activity: none/);
    await expect(promise).rejects.toThrow(/pending requests: id=3 method=turn\/start threadId=thread-123/);
    // Thread-scoped (H4): per-turn timeout rejects with full protocol state but
    // does not kill the shared child.
    expect(child.killCalls).toBe(0);
  });

  it("drops oversized non-JSON stdout diagnostics without killing the app-server turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"timestamp":"2026-04-29T10:18:00Z","level":"WARN","fields":{"message":"<html>' + "x".repeat(1024 * 1024 + 1));
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "ok",
      sessionId: "thread-123",
    });
    expect(child.killCalls).toBe(0);
  });

  it("does not treat oversized log records with nested json-rpc words as protocol output", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"fields":{"error":"Cloudflare challenge","id":"ray","method":"challenge","message":"' + "x".repeat(1024 * 1024 + 1));
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "ok",
      sessionId: "thread-123",
    });
    expect(child.killCalls).toBe(0);
  });

  it("accepts oversized top-level json-rpc responses from large resumed threads", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-large", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    expect(JSON.parse(child.stdin.lines[1] ?? "{}").method).toBe("thread/resume");

    child.stdout.emitData(
      JSON.stringify({
        id: 2,
        result: {
          thread: {
            id: "thread-large",
            turns: [
              {
                items: [
                  {
                    type: "agentMessage",
                    text: "x".repeat(1024 * 1024 + 1),
                  },
                ],
              },
            ],
          },
        },
      }) + "\n",
    );
    await waitFor(() => child.stdin.lines.length >= 3);
    expect(JSON.parse(child.stdin.lines[2] ?? "{}").method).toBe("turn/start");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-large","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-large","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "ok",
      sessionId: undefined,
    });
    expect(child.killCalls).toBe(0);
  });

  it("rejects when app-server stdin write fails", async () => {
    const { child, spawnFn } = createSpawnHarness();
    child.stdin.nextError = new Error("pipe broken");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    await expect(
      adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      }),
    ).rejects.toThrow("pipe broken");
  });
});

describe("Codex native App platform tools", () => {
  async function boot(existing = false, registered = false, callback?: AppPlatformTools["call"], holdStart = false, resolveTools?: (tools: AppPlatformTools) => AppPlatformTools["forSession"], executionInstructions?: string) {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn);
    const controller = new AbortController(), onEngineEvent = vi.fn();
    const tools: AppPlatformTools = {
      definitions: [{ name: "app_send_file", description: "Deliver", inputSchema: { type: "object" } }],
      instructions: "Native App contract", turnInstructions: "Native capability guidance",
      isRegistered: vi.fn(async () => registered), register: vi.fn(async () => { registered = true; }),
      call: vi.fn(callback ?? (async () => ({ text: '{"delivered":true,"messageId":"file-receipt"}' }))),
    };
    if (executionInstructions) Object.assign(tools, { executionInstructions });
    if (resolveTools) tools.forSession = resolveTools(tools);
    const turn = adapter.sendUserMessage(existing ? "existing-thread" : "telegram-new-app", {
      text: "请给我报告", files: [], instructions: "Fallback [send-file:/path]", turnInstructions: "Compatibility details",
      appPlatformTools: tools, onEngineEvent, abortSignal: controller.signal,
    });
    void turn.catch(() => undefined);
    for (const [index, result] of [{}, { thread: { id: "app-thread" } }, { turn: { id: "app-turn" } }].entries()) {
      await waitFor(() => child.stdin.lines.length > index);
      if (holdStart && index === 2) break;
      child.stdout.emitData(JSON.stringify({ id: JSON.parse(child.stdin.lines[index]!).id, result }) + "\n");
    }
    await new Promise((resolve) => setImmediate(resolve));
    const request = (id = "rpc-1", override: Record<string, unknown> = {}) => child.stdout.emitData(JSON.stringify({ id, method: "item/tool/call", params: { threadId: "app-thread", turnId: "app-turn", callId: "call-1", namespace: null, tool: "app_send_file", arguments: { path: "/report" }, ...override } }) + "\n");
    const responses = () => child.stdin.lines.map((s) => JSON.parse(s)).filter((s) => typeof s.id === "string" && s.id.startsWith("rpc-"));
    const finish = () => child.stdout.emitData(JSON.stringify({ method: "turn/completed", params: { threadId: "app-thread", turn: { id: "app-turn", status: "completed", items: [{ type: "agentMessage", text: "Done" }] } } }) + "\n");
    return { adapter, child, tools, turn, controller, onEngineEvent, request, responses, finish };
  }
  it("registers tools on a new thread and keeps platform instructions out of user text", async () => {
    const h = await boot();
    try {
      const start = JSON.parse(h.child.stdin.lines[1]!); expect(start.method).toBe("thread/start");
      expect(start.params.dynamicTools).toEqual([{ type: "function", ...h.tools.definitions[0] }]);
      const turn = JSON.parse(h.child.stdin.lines[2]!);
      expect(turn.params.input[0].text).toBe("请给我报告");
      expect(turn.params.additionalContext["tarocub.app"]).toEqual({ kind: "application", value: "Native App contract\n\nNative capability guidance" });
      h.request(); h.request("rpc-2"); await waitFor(() => h.responses().length === 2);
      expect(h.tools.call).toHaveBeenCalledTimes(1);
      expect(h.responses()[0].result).toEqual({ success: true, contentItems: [{ type: "inputText", text: '{"delivered":true,"messageId":"file-receipt"}' }] });
      expect(h.onEngineEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_result", toolName: "app_send_file" }));
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it.each([false, true])("keeps current execution context separate from long App guidance on resume (registered=%s)", async registered => {
    const context = "Ticket writes: --context-message msg_this_turn. Never bypass tickets by launching an engine CLI directly.";
    const h = await boot(true, registered, undefined, false, tools => {
      tools.instructions = "Long persona and App guidance ".repeat(1000);
      return async () => registered ? { ...tools } : undefined;
    }, context);
    try {
      const turn = JSON.parse(h.child.stdin.lines[2]!);
      expect(turn.params.additionalContext["tarobot.execution"]).toEqual({ kind: "application", value: context });
      expect(turn.params.input[0].text).toBe("请给我报告");
      expect(JSON.parse(h.child.stdin.lines[1]!).params).not.toHaveProperty("additionalContext");
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it.each([false, true])("resumes without creating another session (native registration=%s)", async (registered) => {
    const h = await boot(true, registered);
    try {
      expect(JSON.parse(h.child.stdin.lines[1]!).method).toBe("thread/resume"); expect(h.tools.register).not.toHaveBeenCalled();
      const turn = JSON.parse(h.child.stdin.lines[2]!);
      expect(turn.params.input[0].text).toBe("请给我报告");
      expect(turn.params.additionalContext["tarocub.app"].value).toContain(registered ? "Native App contract" : "Fallback [send-file:");
      h.request(); await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result.success).toBe(registered);
      expect(h.tools.call).toHaveBeenCalledTimes(registered ? 1 : 0);
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it("uses a resumed thread's persisted tool version for instructions and request authorization", async () => {
    const oldCall = vi.fn(async () => ({ text: "old-tool-receipt" }));
    const h = await boot(true, true, undefined, false, (tools) => {
      const old = { ...tools, definitions: [...tools.definitions], instructions: "v1 file contract", turnInstructions: "v1 file procedures", call: oldCall };
      tools.definitions.push({ name: "app_send_batch", description: "new gallery tool", inputSchema: { type: "object" } });
      return vi.fn(async () => old);
    });
    try {
      expect(JSON.parse(h.child.stdin.lines[1]!).method).toBe("thread/resume");
      expect(JSON.parse(h.child.stdin.lines[2]!).params.additionalContext["tarocub.app"].value).toBe("v1 file contract\n\nv1 file procedures");
      h.request("rpc-batch", { tool: "app_send_batch" }); await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result.success).toBe(false);
      h.request("rpc-file"); await waitFor(() => h.responses().length === 2);
      expect(oldCall).toHaveBeenCalledTimes(1); expect(h.tools.call).not.toHaveBeenCalled();
      expect(h.tools.register).not.toHaveBeenCalled(); h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it.each([{ turnId: "other-turn" }, { threadId: "other-thread" }, { namespace: "other" }, { tool: "unknown" }])("refuses a foreign tool request: %j", async (override) => {
    const h = await boot();
    try {
      h.request("rpc-foreign", override); await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result.success).toBe(false); expect(h.tools.call).not.toHaveBeenCalled();
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it("holds early tool calls until the start response proves which turn owns them", async () => {
    const h = await boot(false, false, undefined, true);
    try {
      h.request("rpc-stale", { turnId: "stopped-turn", callId: "stale-file" });
      h.request("rpc-current");
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.tools.call).not.toHaveBeenCalled();
      expect(h.responses()).toHaveLength(0);
      const start = JSON.parse(h.child.stdin.lines[2]!);
      h.child.stdout.emitData(JSON.stringify({ id: start.id, result: { turn: { id: "app-turn" } } }) + "\n");
      await waitFor(() => h.responses().length === 2);
      expect(h.responses().find((response) => response.id === "rpc-stale").result.success).toBe(false);
      expect(h.responses().find((response) => response.id === "rpc-current").result.success).toBe(true);
      expect(h.tools.call).toHaveBeenCalledTimes(1);
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it("settles buffered native calls without execution when stopped before the start response", async () => {
    const h = await boot(false, false, undefined, true);
    try {
      h.request("rpc-early"); h.controller.abort();
      await expect(h.turn).rejects.toThrow("aborted");
      await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result.success).toBe(false); expect(h.tools.call).not.toHaveBeenCalled();
    } finally { h.adapter.destroy(); }
  });
  it("does not turn a confirmed delivery into failure when progress rendering throws", async () => {
    const h = await boot();
    try {
      h.onEngineEvent.mockImplementation((event) => { if (event.type === "tool_result") throw new Error("progress rendering failed"); });
      h.request(); await waitFor(() => h.responses().length === 1);
      expect(h.responses()[0].result.success).toBe(true);
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it("does not promise background delivery after its authorized turn ends", async () => {
    const h = await boot();
    try {
      h.finish(); await h.turn; h.request("rpc-background");
      await waitFor(() => h.responses().length === 1);
      const result = h.responses()[0].result;
      expect(result.success).toBe(false); expect(result.contentItems[0].text).toContain("This call did not deliver a file");
      expect(result.contentItems[0].text).not.toContain("[send-file:");
      expect(h.tools.call).not.toHaveBeenCalled();
    } finally { h.adapter.destroy(); }
  });
  it("rejects changed arguments under a repeated call ID", async () => {
    const h = await boot();
    try {
      h.request(); await waitFor(() => h.responses().length === 1);
      h.request("rpc-2", { arguments: { path: "/other" } }); await waitFor(() => h.responses().length === 2);
      expect(h.responses()[1].result.success).toBe(false); expect(h.tools.call).toHaveBeenCalledTimes(1);
      h.finish(); await h.turn;
    } finally { h.adapter.destroy(); }
  });
  it("cancels a pending native call when stopped and ignores its late completion", async () => {
    let finishCall!: (value: { text: string }) => void;
    let signal: AbortSignal | undefined;
    const h = await boot(false, false, async (input) => { signal = input.abortSignal; return new Promise((resolve) => { finishCall = resolve; }); });
    try {
      h.request(); await waitFor(() => !!signal); h.controller.abort();
      await waitFor(() => h.responses().length === 1); expect(signal!.aborted).toBe(true);
      expect(h.responses()[0].result.success).toBe(false);
      finishCall({ text: "late" }); await new Promise((resolve) => setImmediate(resolve));
      expect(h.responses()).toHaveLength(1);
      await expect(h.turn).rejects.toThrow("aborted");
    } finally { h.adapter.destroy(); }
  });
});
