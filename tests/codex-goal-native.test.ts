import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

const THREAD = "native-goal-thread";
const goal = (status = "active") => ({ threadId: THREAD, objective: "Finish the fixture", status,
  tokenBudget: 500, tokensUsed: 120, timeUsedSeconds: 4, createdAt: 1, updatedAt: 2 });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function fixture() {
  const adapter = new CodexAppServerAdapter("codex", "/tmp/goal-native-fixture");
  const engine = adapter as unknown as {
    loadRuntimeOptions(): Promise<unknown>;
    ensureInitialized(options: unknown): Promise<void>;
    resolveThreadForMessageWithRetry(...args: unknown[]): Promise<string>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    handleMessage(line: string): void;
    goalWatchers: Map<string, unknown>;
    interruptTurn(threadId: string, turnId?: string): void;
  };
  vi.spyOn(engine, "loadRuntimeOptions").mockResolvedValue({});
  vi.spyOn(engine, "ensureInitialized").mockResolvedValue();
  vi.spyOn(engine, "resolveThreadForMessageWithRetry").mockResolvedValue(THREAD);
  let record: ReturnType<typeof goal> | null = goal();
  const request = vi.spyOn(engine, "request").mockImplementation(async (method, params) => {
    if (method === "thread/goal/get") return { goal: record };
    if (method === "thread/goal/clear") { record = null; return { cleared: true }; }
    if (method === "thread/goal/set") {
      record = { ...(record ?? { ...goal(), tokensUsed: 0, timeUsedSeconds: 0 }), ...params } as ReturnType<typeof goal>;
      return { goal: record };
    }
    return {};
  });
  const interrupt = vi.spyOn(engine, "interruptTurn").mockImplementation(() => {});
  const emit = (method: string, params: Record<string, unknown> = {}) => {
    if (method === "thread/goal/updated") record = params.goal as ReturnType<typeof goal>;
    if (method === "thread/goal/cleared") record = null;
    engine.handleMessage(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
  };
  const events: EngineStreamEvent[] = [];
  const watching = (mode?: "replace" | "resume" | "observe", tokenBudget?: number | null) => {
    const result = adapter.watchThreadGoal(THREAD, {
      objective: "Finish the fixture", mode, ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      onEngineEvent: event => { events.push(event); },
    });
    void result.catch(() => {});
    return result;
  };
  return { adapter, engine, request, interrupt, emit, events, watching, setRecord: (value: ReturnType<typeof goal> | null) => { record = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Codex native goal protocol alignment", () => {
  it.each(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"])("reads native %s without inventing an empty goal", async status => {
    const f = fixture();
    try { f.setRecord(goal(status)); expect((await f.adapter.getThreadGoal(THREAD)).goal).toEqual(goal(status)); }
    finally { f.adapter.destroy(); }
  });

  it("rejects an unrecognized goal response instead of claiming no goal", async () => {
    const f = fixture();
    try {
      f.request.mockResolvedValue({ goal: { ...goal(), status: "future-status" } });
      await expect(f.adapter.getThreadGoal(THREAD)).rejects.toThrow(/goal.*response/i);
    } finally { f.adapter.destroy(); }
  });

  it("patches a goal with explicit user provenance while preserving objective, budget and counters", async () => {
    const f = fixture();
    try {
      const result = await f.adapter.updateThreadGoal(THREAD, { status: "paused" });
      expect(f.request).toHaveBeenCalledWith("thread/goal/set", { threadId: THREAD, status: "paused", origin: "user" }, expect.anything());
      expect(result.goal).toEqual(goal("paused"));
      expect(f.request.mock.calls.map(([method]) => method)).not.toContain("thread/goal/clear");
    } finally { f.adapter.destroy(); }
  });

  it("resumes without replacing the objective or resetting budget/usage", async () => {
    const f = fixture(); f.setRecord(goal("paused"));
    try {
      const watching = f.watching("resume"); await flush();
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/set"]);
      expect(f.request.mock.calls[0]?.[1]).toEqual({ threadId: THREAD, status: "active", origin: "user" });
      f.emit("thread/goal/updated", { goal: goal("complete") });
      expect((await watching).goal).toEqual(goal("complete"));
    } finally { f.adapter.destroy(); }
  });

  it("resumes with an explicitly changed budget without clearing accumulated usage", async () => {
    const f = fixture(); f.setRecord(goal("budgetLimited"));
    try {
      const watching = f.watching("resume", 800); await flush();
      expect(f.request.mock.calls[0]?.[1]).toEqual({ threadId: THREAD, status: "active", origin: "user", tokenBudget: 800 });
      f.emit("thread/goal/updated", { goal: { ...goal("complete"), tokenBudget: 800 } });
      expect((await watching).goal?.tokensUsed).toBe(120);
    } finally { f.adapter.destroy(); }
  });

  it.each(["paused", "blocked", "usageLimited", "budgetLimited", "complete"])("observes idle %s without clearing it", async status => {
    const f = fixture(); f.setRecord(goal(status));
    try {
      const watching = f.watching("observe"); await flush();
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/get"]);
      let result: unknown; void watching.then(value => { result = value; }); await flush();
      expect(result).toMatchObject({ goal: goal(status) });
      expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it("drains the existing goal turn on pause without interrupting it or waiting for another goal", async () => {
    const f = fixture(); vi.useFakeTimers();
    try {
      const watching = f.watching("observe"); await flush();
      f.emit("turn/started", { turn: { id: "owned-turn" } });
      f.emit("thread/goal/updated", { goal: goal("paused") });
      let done = false; void watching.then(() => { done = true; }); await flush();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(f.interrupt).not.toHaveBeenCalled();
      expect(done).toBe(false);
      f.emit("turn/completed", { turn: { id: "owned-turn", items: [{ type: "agentMessage", text: "Paused after this step." }] } });
      expect((await watching).goal?.status).toBe("paused");
      expect(f.events).toContainEqual(expect.objectContaining({ type: "result", text: "Paused after this step." }));
    } finally { f.adapter.destroy(); }
  });

  it("consumes native clear as null without resurrecting the original set response", async () => {
    const f = fixture();
    try {
      const watching = f.watching(); await flush();
      f.emit("thread/goal/cleared");
      let result: unknown; void watching.then(value => { result = value; }); await flush();
      expect(result).toMatchObject({ goal: null });
      expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it("ignores its replacement's preparatory clear notification", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, ...extra) => {
      if (method === "thread/goal/clear") f.emit("thread/goal/cleared");
      return original(method, params, ...extra);
    });
    try {
      const watching = f.watching(); await flush();
      let done = false; void watching.then(() => { done = true; }); await flush();
      expect(done).toBe(false);
      f.emit("thread/goal/updated", { goal: goal("complete") });
      expect((await watching).goal?.status).toBe("complete");
    } finally { f.adapter.destroy(); }
  });

  it("confirms a delayed preparatory clear after the replacement set reply", async () => {
    const f = fixture();
    try {
      const watching = f.watching(); await flush();
      let done = false; void watching.then(() => { done = true; });
      // Native clear sends its response before its ordered notification. The
      // new goal can already be set when that old notification is delivered.
      f.emit("thread/goal/cleared"); f.setRecord(goal()); await flush();
      expect(done).toBe(false);
      expect(f.engine.goalWatchers.size).toBe(1);
      f.emit("thread/goal/updated", { goal: goal("complete") }); await watching;
    } finally { f.adapter.destroy(); }
  });

  it("does not end a resumed goal on the previous pause's delayed notification", async () => {
    const f = fixture(); f.setRecord(goal("paused"));
    try {
      const watching = f.watching("resume"); await flush();
      let done = false; void watching.then(() => { done = true; });
      f.emit("thread/goal/updated", { goal: goal("paused") }); f.setRecord(goal("active")); await flush();
      expect(done).toBe(false); expect(f.engine.goalWatchers.size).toBe(1);
      // A genuine later pause still ends observation after native confirmation.
      f.emit("thread/goal/updated", { goal: goal("paused") });
      expect((await watching).goal?.status).toBe("paused");
    } finally { f.adapter.destroy(); }
  });

  it("does not let a previous turn's late completion terminate the replacement", async () => {
    const f = fixture();
    try {
      const watching = f.watching(); await flush();
      let done = false; void watching.then(() => { done = true; });
      f.emit("thread/goal/updated", { turnId: "previous-native-turn", goal: goal("complete") }); f.setRecord(goal()); await flush();
      expect(done).toBe(false);
      f.emit("thread/goal/updated", { goal: goal("paused") }); await watching;
    } finally { f.adapter.destroy(); }
  });

  it("does not let delayed active state undo a confirmed pause while its turn drains", async () => {
    const f = fixture();
    try {
      const watching = f.watching("observe"); await flush();
      f.emit("turn/started", { turn: { id: "draining-turn" } });
      f.emit("thread/goal/updated", { goal: goal("paused") }); await flush();
      f.emit("thread/goal/updated", { goal: goal("active") }); f.setRecord(goal("paused")); await flush();
      f.emit("turn/completed", { turn: { id: "draining-turn", items: [{ type: "agentMessage", text: "Paused safely" }] } });
      let result: unknown; void watching.then(value => { result = value; }); await flush();
      expect(result).toMatchObject({ goal: goal("paused") });
    } finally { f.adapter.destroy(); }
  });

  it("coalesces delayed status bursts without polling when no new event arrives", async () => {
    const f = fixture();
    try {
      const watching = f.watching("observe"); await flush();
      let done = false; void watching.then(() => { done = true; });
      let release!: (value: unknown) => void;
      f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      f.emit("thread/goal/updated", { goal: goal("paused") }); await flush();
      for (let i = 0; i < 20; i++) f.emit("thread/goal/updated", { goal: goal("paused") });
      f.setRecord(goal()); await flush();
      expect(f.request.mock.calls.filter(([method]) => method === "thread/goal/get")).toHaveLength(2);
      release({ goal: goal("paused") }); await flush();
      expect(done).toBe(false);
      expect(f.request.mock.calls.filter(([method]) => method === "thread/goal/get")).toHaveLength(3);
      await flush();
      expect(f.request.mock.calls.filter(([method]) => method === "thread/goal/get")).toHaveLength(3);
      f.emit("thread/goal/updated", { goal: goal("paused") }); await watching;
    } finally { f.adapter.destroy(); }
  });

  it("uses an explicit null poll to finish a missed clear notification", async () => {
    const f = fixture(); vi.useFakeTimers();
    try {
      const watching = f.watching("observe"); await flush();
      f.setRecord(null);
      await vi.advanceTimersByTimeAsync(30_000);
      let result: unknown; void watching.then(value => { result = value; }); await flush();
      expect(result).toMatchObject({ goal: null });
    } finally { f.adapter.destroy(); }
  });

  it("ignores an old poll after a newer notification", async () => {
    const f = fixture(); vi.useFakeTimers();
    try {
      const watching = f.watching("observe"); await flush();
      let release!: (value: unknown) => void;
      f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await vi.advanceTimersByTimeAsync(30_000);
      f.emit("thread/goal/updated", { goal: { ...goal(), updatedAt: 3 } });
      release({ goal: null }); await flush();
      let done = false; void watching.then(() => { done = true; }); await flush();
      expect(done).toBe(false);
      f.emit("thread/goal/updated", { goal: goal("complete") }); await watching;
    } finally { f.adapter.destroy(); }
  });

  it("does not overwrite a newer terminal notification with a delayed set response", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, ...extra) => {
      const result = await original(method, params, ...extra);
      if (method === "thread/goal/set") f.emit("thread/goal/updated", { goal: goal("blocked") });
      return result;
    });
    try {
      const watching = f.watching(); await flush();
      let result: unknown; void watching.then(value => { result = value; }); await flush();
      expect(result).toMatchObject({ goal: goal("blocked") });
    } finally { f.adapter.destroy(); }
  });

  it("rejects a second observer instead of orphaning the first", async () => {
    const f = fixture();
    try {
      const first = f.watching("observe"); await flush();
      const second = f.watching("observe");
      await expect(second).rejects.toThrow(/goal.*already/i);
      f.emit("thread/goal/updated", { goal: goal("complete") }); await first;
    } finally { f.adapter.destroy(); }
  });

  it("serializes an immediate pause after goal creation so setup cannot resume it again", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    let held = true;
    f.request.mockImplementation(async (method, params, ...extra) => {
      if (method === "thread/goal/set" && held) { held = false; await new Promise<void>(resolve => { release = resolve; }); }
      return original(method, params, ...extra);
    });
    try {
      const watching = f.watching(); await flush();
      const pausing = f.adapter.updateThreadGoal(THREAD, { status: "paused" }); await flush();
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/clear", "thread/goal/set"]);
      release();
      expect((await pausing).goal?.status).toBe("paused");
      expect((await watching).goal?.status).toBe("paused");
      expect(f.request.mock.calls.map(([, params]) => params.status)).toEqual([undefined, "active", "paused"]);
    } finally { release?.(); f.adapter.destroy(); }
  });

  it("waits for setup before clearing and never recreates the goal after clear", async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    let release!: () => void;
    f.request.mockImplementation(async (method, params, ...extra) => {
      if (method === "thread/goal/set") await new Promise<void>(resolve => { release = resolve; });
      return original(method, params, ...extra);
    });
    try {
      const watching = f.watching(); await flush();
      const clearing = f.adapter.clearThreadGoal(THREAD); await flush();
      expect(f.request.mock.calls).toHaveLength(2);
      release(); await clearing;
      expect((await watching).goal).toBeNull();
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/clear", "thread/goal/set", "thread/goal/clear"]);
    } finally { release?.(); f.adapter.destroy(); }
  });

  it("does not replace the existing goal when the preparatory clear fails", async () => {
    const f = fixture();
    try {
      f.request.mockRejectedValueOnce(new Error("clear rejected"));
      await expect(f.watching()).rejects.toThrow("clear rejected");
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/clear"]);
      expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it("keeps a newer clear notification when a set response arrives late", async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, ...extra) => {
      const result = await original(method, params, ...extra);
      if (method === "thread/goal/set") f.emit("thread/goal/cleared");
      return result;
    });
    try { expect((await f.watching()).goal).toBeNull(); }
    finally { f.adapter.destroy(); }
  });

  it("reports a malformed poll as failure while preserving the native target", async () => {
    const f = fixture(); vi.useFakeTimers();
    try {
      const watching = f.watching("observe"); await flush();
      f.request.mockResolvedValueOnce({});
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(watching).rejects.toThrow(/goal response/);
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/get", "thread/goal/get"]);
      expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it("does not let a stale poll retire its replacement observer", async () => {
    const f = fixture(); vi.useFakeTimers();
    try {
      const first = f.watching("observe"); await flush();
      const original = f.request.getMockImplementation()!;
      let release!: (value: unknown) => void;
      f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await vi.advanceTimersByTimeAsync(30_000);
      f.emit("thread/goal/updated", { goal: goal("paused") }); await first;
      f.request.mockImplementation(original);
      const second = f.watching("resume"); await flush();
      let done = false; void second.then(() => { done = true; });
      release({ goal: null }); await flush();
      expect(done).toBe(false); expect(f.engine.goalWatchers.size).toBe(1);
      f.emit("thread/goal/updated", { goal: goal("complete") }); await second;
    } finally { f.adapter.destroy(); }
  });

  it("refreshes a missed suspension through an explicit status read", async () => {
    const f = fixture();
    try {
      const watching = f.watching("observe"); await flush();
      f.setRecord(goal("blocked"));
      expect((await f.adapter.getThreadGoal(THREAD)).goal?.status).toBe("blocked");
      expect((await watching).goal?.status).toBe("blocked");
    } finally { f.adapter.destroy(); }
  });

  it("uses automatic provenance only for automatic clear requests", async () => {
    const f = fixture();
    try {
      await f.adapter.clearThreadGoal(THREAD, { origin: "automatic" });
      expect(f.request.mock.calls[0]?.[1]).toEqual({ threadId: THREAD, origin: "automatic" });
      await f.adapter.clearThreadGoal(THREAD);
      expect(f.request.mock.calls[1]?.[1]).toEqual({ threadId: THREAD, origin: "user" });
    } finally { f.adapter.destroy(); }
  });


  it("does not set a goal after cancellation during the final ownership check", async () => {
    const f = fixture(), abort = new AbortController(); let checks = 0;
    try {
      await expect(f.adapter.watchThreadGoal(THREAD, { objective: "new objective", abortSignal: abort.signal,
        isCurrentSession: async () => { if (++checks === 3) abort.abort(); return true; },
      })).rejects.toThrow(/abort/i);
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/clear"]);
      expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it("cleans the exact owned goal after cancellation and a malformed setup response", async () => {
    const f = fixture(), abort = new AbortController(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, ...extra) => {
      const result = await original(method, params, ...extra);
      if (method === "thread/goal/set") { abort.abort(); return {}; }
      return result;
    });
    try {
      await expect(f.adapter.watchThreadGoal(THREAD, { objective: "new objective", abortSignal: abort.signal })).rejects.toThrow("Invalid Codex goal response");
      expect(f.request.mock.calls.map(([method, params]) => [method, params.threadId, params.origin])).toEqual([
        ["thread/goal/clear", THREAD, "user"], ["thread/goal/set", THREAD, "user"], ["thread/goal/clear", THREAD, "automatic"],
      ]);
      // Teardown must neither re-resolve a stale session nor follow a fallback
      // native thread. It already owns this exact original thread and watcher.
      expect(f.engine.resolveThreadForMessageWithRetry).toHaveBeenCalledTimes(1);
      expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it.each(["pause", "clear", "resume"])("rechecks %s session ownership after delayed initialization", async action => {
    const f = fixture(); let current = true, release!: () => void;
    vi.mocked(f.engine.ensureInitialized).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const guard = () => current;
      const result = action === "pause" ? f.adapter.updateThreadGoal(THREAD, { status: "paused", isCurrentSession: guard })
        : action === "clear" ? f.adapter.clearThreadGoal(THREAD, { isCurrentSession: guard })
        : f.adapter.watchThreadGoal(THREAD, { objective: "existing", mode: "resume", isCurrentSession: guard });
      void result.catch(() => {}); await flush(); current = false; release();
      await expect(result).rejects.toThrow("session binding changed");
      expect(f.request).not.toHaveBeenCalled(); expect(f.engine.goalWatchers.size).toBe(0);
    } finally { release?.(); f.adapter.destroy(); }
  });

  it("does not resume after ownership changed during session publication", async () => {
    const f = fixture(); let current = true;
    try {
      await expect(f.adapter.watchThreadGoal(THREAD, { objective: "existing", mode: "resume", isCurrentSession: () => current,
        onEngineEvent: event => { if (event.type === "session") current = false; },
      })).rejects.toThrow("session binding changed");
      expect(f.request).not.toHaveBeenCalled(); expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

  it("rechecks pause ownership after waiting for initial goal setup", async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    let release!: () => void, current = true;
    f.request.mockImplementation(async (method, params, ...extra) => {
      if (method === "thread/goal/set") await new Promise<void>(resolve => { release = resolve; });
      return original(method, params, ...extra);
    });
    try {
      const watching = f.watching(); await flush();
      const pausing = f.adapter.updateThreadGoal(THREAD, { status: "paused", isCurrentSession: () => current });
      void pausing.catch(() => {}); await flush(); current = false; release();
      await expect(pausing).rejects.toThrow("session binding changed");
      expect(f.request.mock.calls.map(([, params]) => params.status)).toEqual([undefined, "active"]);
      f.emit("thread/goal/updated", { goal: goal("complete") }); await watching;
    } finally { release?.(); f.adapter.destroy(); }
  });

  it.each(["edit", "clear", "resume"])("does not apply guarded %s to a fallback replacement thread", async action => {
    const f = fixture();
    vi.mocked(f.engine.resolveThreadForMessageWithRetry).mockResolvedValue("unexpected-replacement-thread");
    try {
      const guard = () => true;
      const result = action === "edit" ? f.adapter.updateThreadGoal(THREAD, { objective: "edit old target", isCurrentSession: guard })
        : action === "clear" ? f.adapter.clearThreadGoal(THREAD, { isCurrentSession: guard })
        : f.adapter.watchThreadGoal(THREAD, { objective: "old target", mode: "resume", isCurrentSession: guard });
      await expect(result).rejects.toThrow("session binding changed");
      expect(f.request).not.toHaveBeenCalled(); expect(f.engine.goalWatchers.size).toBe(0);
    } finally { f.adapter.destroy(); }
  });

});
