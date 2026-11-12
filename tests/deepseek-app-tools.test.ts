import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { NativeAppPipe } from "../src/codex/native-app-pipe.js";
import { DeepSeekAppTools } from "../src/codex/deepseek-app-tools.js";
import { connectDeepSeekAppPlugin } from "../src/codex/deepseek-app-plugin.js";
import type { AppPlatformTools } from "../src/codex/adapter.js";

function paired(handler: ConstructorParameters<typeof NativeAppPipe>[2]) {
  const hostInput = new PassThrough(), hostOutput = new PassThrough();
  const host = new NativeAppPipe(hostInput, hostOutput, handler), child = new NativeAppPipe(hostOutput, hostInput, async () => ({}));
  return { host, child, close: () => { host.close(); child.close(); }, hostInput };
}
describe("private native App pipes", () => {
  it("correlates responses and carries cancellation without exposing handler exceptions", async () => {
    let running: AbortSignal | undefined;
    const f = paired(async (method, payload, signal) => {
      if (method === "echo") return payload;
      if (method === "fail") throw new Error("private-secret");
      running = signal; await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return "stopped";
    });
    try {
      expect(await Promise.all([f.child.request("echo", "one"), f.child.request("echo", "中文")])).toEqual(["one", "中文"]);
      await expect(f.child.request("fail", {})).rejects.toThrow("delivery may have occurred");
      const abort = new AbortController(); const slow = f.child.request("slow", {}, abort.signal);
      const rejected = expect(slow).rejects.toThrow("cancelled"); await vi.waitFor(() => expect(running).toBeDefined()); abort.abort(); await rejected;
      await vi.waitFor(() => expect(running!.aborted).toBe(true));
    } finally { f.close(); }
  });
  it("closes oversized/malformed pipes and rejects unfinished requests", async () => {
    for (const invalid of ["not-json\n", "x".repeat(1024 * 1024 + 1)]) {
      const f = paired(async () => new Promise(() => {}));
      try { const pending = f.child.request("work", {}); const rejected = expect(pending).rejects.toThrow("closed"); f.hostInput.write(invalid); await rejected; }
      finally { f.close(); }
    }
  });
  it("rejects an oversized outgoing request or response without breaking other turns", async () => {
    const f = paired(async (method, payload) => method === "large" ? "x".repeat(1024 * 1024 + 1) : payload);
    try {
      await expect(f.child.request("echo", "x".repeat(1024 * 1024 + 1))).rejects.toThrow("not dispatched");
      expect(await f.child.request("echo", "still available")).toBe("still available");
      await expect(f.child.request("large", {})).rejects.toThrow("delivery may have occurred");
      expect(await f.child.request("echo", "after response")).toBe("after response");
    } finally { f.close(); }
  });
});

describe("DeepSeek scoped native plugin", () => {
  async function fixture() {
    type Event = { type: string; seq: number; data: Record<string, unknown> };
    const input = new PassThrough(), output = new PassThrough(), sourceRpcId = randomUUID();
    const args = { path: "/workspace/a.txt", kind: "file" }, events: Event[] = [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      { type: "user/message", seq: 1, data: { source: { kind: "user", rpcId: sourceRpcId } } },
      { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
      { type: "tool/call", seq: 3, data: { turn: 1, step: 1, callId: "call1", name: "app_send_file", arguments: JSON.stringify(args) } },
    ];
    const definitions = new Map<string, any>(), disposers: (() => void)[] = [], remove = vi.fn();
    const nextTurn: Array<{ id: string; source: { kind: string; rpcId: string } }> = [], nextStep: typeof nextTurn = [];
    const cancel = vi.fn(), retirePrompt = vi.fn();
    const goalGet = vi.fn((): { id?: string; revision?: number; phase: string; activation: string } | undefined => undefined);
    let initiator: unknown;
    const goalPause = vi.fn((_agent: unknown, ref: { id: string; revision: number }) => {
      expect(initiator).toBe(agent);
      return { id: ref.id, revision: ref.revision + 1 };
    });
    const withInitiator = <T>(agent: unknown, operation: () => T): T => { initiator = agent; try { return operation(); } finally { initiator = undefined; } };
    const services = { fileUploads: { retirePrompt }, goals: { get: goalGet, pause: goalPause }, sessionProjections: { register: vi.fn(() => vi.fn()) } };
    const hooks = new Map<string, (...args: any[]) => any>();
    const inbox = { nextTurn, nextStep, remove: vi.fn((id: string) => {
      for (const list of [nextTurn, nextStep]) { const index = list.findIndex((message) => message.id === id); if (index >= 0) { list.splice(index, 1); return true; } }
      return false;
    }) };
    const agent = { id: "session1", status: "idle", inbox, cancel, inject: vi.fn((message: any) => { nextStep.push(message); }), session: { snapshotEvents: () => events }, ctx: {
      tools: { register: (raw: unknown) => { const tool = raw as { name: string }; definitions.set(tool.name, tool); return () => { remove(); definitions.delete(tool.name); }; } },
      effect: (effect: () => (() => void)) => { disposers.push(effect()); },
    } };
    const close = await connectDeepSeekAppPlugin({ agents: { get: (id) => id === agent.id ? agent : undefined, withInitiator }, get: (name) => services[name], on: (name, handler) => { hooks.set(name, handler); return () => { hooks.delete(name); }; }, effect: () => {} }, input, output);
    const call = vi.fn(async () => ({ text: "receipt" })), host = new NativeAppPipe(output, input, call);
    const install = (description = "send") => host.request("install", { sessionId: agent.id, definitions: [{ name: "app_send_file", description, inputSchema: { type: "object" } }] });
    const controller = new AbortController(), exec = { agent, callId: "call1", rootCallId: "call1", signal: controller.signal };
    const run = (execution = exec, argumentsOverride: unknown = args) => definitions.get("app_send_file").execute(argumentsOverride, execution);
    return { events, agent, args, exec, controller, sourceRpcId, call, host, install, run, definitions, remove, retirePrompt, goalGet, goalPause, services,
      hooks,
      preStep: (turn = 1) => hooks.get("agent/pre-step")?.({ agent, turn, signal: controller.signal }, async () => ({ kind: "enter" })),
      steer: (extra: Record<string, unknown> = {}) => host.request("steer-prompt", { sessionId: agent.id, sourceRpcId, expectedTurn: 1, requestId: randomUUID(), text: "use new direction", clientTimeZone: "Asia/Shanghai", ...extra }),
      claim: (turn: number, rpcId = sourceRpcId, kind = "user") => hooks.get("agent/inbox/claimed")?.({ agent, turn, message: { id: randomUUID(), source: { kind, rpcId } } }),
      close: async () => { await close(); host.close(); for (const dispose of disposers) dispose(); } };
  }
  it.each([true, false])("installs the workbench alongside the current native App tools (widgets=%s)", async widgets => {
    const f = await fixture();
    try {
      const names = ["app_send_file", "app_send_batch", "app_capability", ...(widgets ? ["app_show_widget"] : []), "app_workbench"];
      const definitions = names.map(name => ({ name, description: name, inputSchema: { type: "object" } }));
      expect(await f.host.request("install", { sessionId: f.agent.id, definitions })).toEqual({ installed: true });
      expect([...f.definitions.keys()]).toEqual(names);
      const args = { operation: "targets", requestId: "scoped-workbench" };
      f.events[3]!.data.name = "app_workbench"; f.events[3]!.data.arguments = JSON.stringify(args);
      expect(await f.definitions.get("app_workbench").execute(args, f.exec)).toEqual({ text: "receipt" });
      expect(f.call).toHaveBeenCalledWith("call", expect.objectContaining({ name: "app_workbench", sourceRpcId: f.sourceRpcId, arguments: args }), expect.any(AbortSignal));
      await expect(f.host.request("install", { sessionId: f.agent.id, definitions: [...definitions, { name: "untrusted_tool", description: "", inputSchema: {} }] })).rejects.toThrow();
      expect([...f.definitions.keys()]).toEqual(names);
    } finally { await f.close(); }
  });
  it("keeps native usage registered after pipe loss until the plugin itself is disposed", async () => {
    const f = await fixture();
    const releaseUsage = f.services.sessionProjections.register.mock.results[0]!.value;
    f.host.close(); await Promise.resolve();
    expect(releaseUsage).not.toHaveBeenCalled();
    await f.close(); expect(releaseUsage).toHaveBeenCalled();
  });
  it.each(["goal", "ordinary", "different-goal", "ended", "claimed-goal", "context-before-goal", "stale-ref", "missing-service"])("isolates budget pause from unrelated work: %s", async (scenario) => {
    const f = await fixture();
    try {
      f.agent.status = "running";
      f.goalGet.mockReturnValue({ id: "goal-a", revision: 4, phase: "active", activation: "armed" });
      const source = { kind: "goal", goalId: scenario === "different-goal" ? "goal-b" : "goal-a", round: 1 };
      if (["goal", "different-goal", "context-before-goal"].includes(scenario)) f.events[1]!.data.source = source;
      if (scenario === "context-before-goal") f.events.splice(1, 0, { type: "user/message", seq: 0.5, data: { source: { kind: "runtime-context" } } });
      if (scenario === "claimed-goal") {
        f.events.splice(1);
        f.hooks.get("agent/inbox/claimed")?.({ agent: f.agent, turn: 1, message: { id: "claim", source } });
      }
      if (scenario === "ended") f.events.push({ type: "turn/end", seq: 4, data: { turn: 1 } });
      if (scenario === "missing-service") (f.services.goals as any).pause = undefined;
      const response = await f.host.request("pause-goal-budget", { sessionId: f.agent.id, ref: { id: "goal-a", revision: scenario === "stale-ref" ? 3 : 4 } });
      if (scenario === "stale-ref" || scenario === "missing-service") {
        expect(response).toEqual({ outcome: scenario === "stale-ref" ? "stale" : "unsupported" }); expect(f.goalPause).not.toHaveBeenCalled();
      } else {
        expect(response).toEqual({ outcome: "paused", ref: { id: "goal-a", revision: 5 } }); expect(f.goalPause).toHaveBeenCalledOnce();
      }
      expect(f.agent.cancel).toHaveBeenCalledTimes(["goal", "claimed-goal", "context-before-goal"].includes(scenario) ? 1 : 0);
    } finally { await f.close(); }
  });
  it.each(["current", "queued", "goal", "new-user", "ended", "next-turn", "aborted", "preparing", "missing-host-api"])("scopes steering to native origin and live non-aborted turn: %s", async (scenario) => {
    const f = await fixture();
    try {
      f.agent.status = "running";
      if (scenario !== "preparing") await f.preStep();
      if (scenario === "queued") f.agent.inbox.nextTurn.push({ id: "queued", source: { kind: "user", rpcId: f.sourceRpcId } });
      if (scenario === "goal" || scenario === "new-user") f.events[1]!.data.source = { kind: scenario === "goal" ? "goal" : "user", rpcId: randomUUID() };
      if (scenario === "ended") f.events.push({ type: "turn/end", seq: 4, data: { turn: 1 } });
      if (scenario === "next-turn") f.events[0]!.data.turn = 2;
      if (scenario === "aborted") f.controller.abort();
      if (scenario === "missing-host-api") (f.agent as any).inject = undefined;
      const outcome = scenario === "current" ? "accepted" : scenario === "queued" ? "queued" : scenario === "preparing" ? "not_ready" : scenario === "missing-host-api" ? "unsupported" : "stale";
      expect(await f.steer()).toEqual({ outcome });
      expect(f.agent.inbox.nextStep).toHaveLength(scenario === "current" ? 1 : 0);
      if (scenario === "current") {
        const message = f.agent.inbox.nextStep[0]!;
        expect(message).toMatchObject({ role: "user", content: [{ type: "text", text: "use new direction" }], source: { kind: "tarocub-steer", clientTimeZone: "Asia/Shanghai", targetTurn: 1, targetRpcId: f.sourceRpcId } });
        expect(message.source.rpcId).not.toBe(f.sourceRpcId);
        expect(Object.isFrozen(message)).toBe(true);
      }
      expect(f.agent.cancel).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["abort", "end", "pipe-close"])("removes only unconsumed steering when the intended turn exits: %s", async (how) => {
    const f = await fixture();
    try {
      f.agent.status = "running"; await f.preStep();
      expect(await f.steer()).toEqual({ outcome: "accepted" });
      const unrelated = { id: "unrelated", source: { kind: "user", rpcId: randomUUID() } };
      f.agent.inbox.nextStep.push(unrelated);
      f.agent.inbox.nextTurn.push(unrelated);
      if (how === "abort") f.controller.abort();
      else if (how === "end") { f.hooks.get("session/event")?.(f.agent.session, { type: "turn/end", data: { turn: 1 } }); await Promise.resolve(); }
      else await f.close();
      expect(f.agent.inbox.nextStep).toEqual([unrelated]);
      expect(f.agent.inbox.nextTurn).toEqual([unrelated]);
    } finally { await f.close(); }
  });
  it("does not remove consumed steering or treat another session's end as the target end", async () => {
    const f = await fixture();
    try {
      f.agent.status = "running"; await f.preStep(); await f.steer();
      const message = f.agent.inbox.nextStep[0]!;
      f.hooks.get("session/event")?.({}, { type: "turn/end", data: { turn: 1 } });
      expect(f.agent.inbox.nextStep).toHaveLength(1);
      f.agent.inbox.nextStep.splice(0);
      f.hooks.get("agent/inbox/claimed")?.({ agent: f.agent, turn: 1, message });
      f.controller.abort(); expect(f.agent.inbox.remove).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["error", "blocked"])("cleans before the native end append and hasPending check: %s", async (how) => {
    const f = await fixture();
    try {
      f.agent.status = "running"; await f.preStep(); await f.steer();
      if (how === "error") f.hooks.get("agent/error")?.({ agent: f.agent, turn: 1 });
      else await f.hooks.get("agent/pre-step")?.({ agent: f.agent, turn: 1, signal: f.controller.signal }, async () => ({ kind: "reject" }));
      expect(f.agent.inbox.nextStep).toEqual([]);
      f.agent.inbox.remove.mockImplementation(() => { throw new Error("session append cannot reenter"); });
      f.hooks.get("session/event")?.(f.agent.session, { type: "turn/end", data: { turn: 1 } });
      await Promise.resolve(); expect(f.agent.inbox.remove).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it("retries a failed removal without dropping bookkeeping or throwing from abort", async () => {
    const f = await fixture();
    try {
      f.agent.status = "running"; await f.preStep(); await f.steer();
      f.agent.inbox.remove.mockImplementationOnce(() => { throw new Error("temporary publication lock"); });
      expect(() => f.controller.abort()).not.toThrow(); expect(f.agent.inbox.nextStep).toHaveLength(1);
      f.hooks.get("agent/error")?.({ agent: f.agent, turn: 1 });
      expect(f.agent.inbox.nextStep).toEqual([]);
    } finally { await f.close(); }
  });
  it("removes persisted private steering on resume while preserving real queued input", async () => {
    const f = await fixture();
    try {
      const ordinary = { id: "ordinary", source: { kind: "user", rpcId: randomUUID() } };
      f.agent.inbox.nextTurn.push(ordinary);
      f.agent.inbox.nextStep.push({ id: "from-crashed-host", source: { kind: "tarocub-steer", rpcId: randomUUID() } });
      await f.hooks.get("agent/created")?.({ agent: f.agent });
      expect(f.agent.inbox.nextStep).toEqual([]); expect(f.agent.inbox.nextTurn).toEqual([ordinary]);
    } finally { await f.close(); }
  });
  it.each(["nextTurn", "nextStep"] as const)("withdraws only the matching %s input without interrupting a goal", async (target) => {
    const f = await fixture();
    try {
      f.agent.status = "running"; f.events[1]!.data.source = { kind: "goal", round: 1 };
      const other = { id: "other", source: { kind: "user", rpcId: randomUUID() } };
      f.agent.inbox[target].push(other, { id: "withdraw", source: { kind: "user", rpcId: f.sourceRpcId } });
      expect(await f.host.request("cancel-prompt", { sessionId: f.agent.id, sourceRpcId: f.sourceRpcId })).toEqual({ outcome: "removed" });
      expect(f.agent.inbox[target]).toEqual([other]); expect(f.agent.cancel).not.toHaveBeenCalled();
      expect(f.retirePrompt).toHaveBeenCalledWith(f.agent, f.sourceRpcId);
    } finally { await f.close(); }
  });
  it.each(["current", "completed", "new-user", "goal", "steering", "wrong-session"])("checks native ownership at mutation time: %s", async (scenario) => {
    const f = await fixture();
    try {
      f.agent.status = "running";
      if (scenario === "completed") f.events.push({ seq: 4, type: "turn/end", data: { turn: 1 } });
      if (scenario === "new-user" || scenario === "goal") f.events.push({ seq: 4, type: "turn/end", data: { turn: 1 } }, { seq: 5, type: "turn/start", data: { turn: 2 } }, { seq: 6, type: "user/message", data: { source: scenario === "goal" ? { kind: "goal", round: 2 } : { kind: "user", rpcId: randomUUID() } } });
      if (scenario === "steering") f.events.splice(1, 0, { seq: 0, type: "user/message", data: { source: { kind: "goal", round: 1 } } });
      const result = await f.host.request("cancel-prompt", { sessionId: scenario === "wrong-session" ? "other-session" : f.agent.id, sourceRpcId: f.sourceRpcId });
      expect(result).toEqual({ outcome: scenario === "current" ? "cancelled" : scenario === "wrong-session" ? "missing" : scenario === "steering" ? "merged" : "settled" });
      expect(f.agent.cancel).toHaveBeenCalledTimes(scenario === "current" ? 1 : 0);
      if (scenario === "current") expect(f.agent.cancel).toHaveBeenCalledWith({ kind: "user" }, { keepInbox: true });
    } finally { await f.close(); }
  });
  it.each(["matching", "goal", "previous-turn"])("handles claimed input before async prompt assembly finishes: %s", async (scenario) => {
    const f = await fixture();
    try {
      f.agent.status = "running"; f.events.splice(1);
      f.claim(scenario === "previous-turn" ? 0 : 1, f.sourceRpcId, scenario === "goal" ? "goal" : "user");
      const result = await f.host.request("cancel-prompt", { sessionId: f.agent.id, sourceRpcId: f.sourceRpcId });
      expect(result).toEqual({ outcome: scenario === "matching" ? "cancelled" : "missing" });
      expect(f.agent.cancel).toHaveBeenCalledTimes(scenario === "matching" ? 1 : 0);
      if (scenario === "matching") expect(f.retirePrompt).toHaveBeenCalledWith(f.agent, f.sourceRpcId);
    } finally { await f.close(); }
  });
  it("refuses active-message cancellation that would pause an armed native goal", async () => {
    const f = await fixture();
    try {
      f.agent.status = "running"; f.goalGet.mockReturnValue({ phase: "active", activation: "armed" });
      expect(await f.host.request("cancel-prompt", { sessionId: f.agent.id, sourceRpcId: f.sourceRpcId })).toEqual({ outcome: "goal-active" });
      expect(f.agent.cancel).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["tool-jobs", "ptc-mode", "goal", "user"])("distinguishes carried context from another turn owner: %s", async (kind) => {
    const f = await fixture();
    try {
      f.agent.status = "running"; f.events.splice(1);
      f.claim(1, randomUUID(), kind); f.claim(1);
      expect(await f.host.request("cancel-prompt", { sessionId: f.agent.id, sourceRpcId: f.sourceRpcId })).toEqual({ outcome: ["goal", "user"].includes(kind) ? "merged" : "cancelled" });
    } finally { await f.close(); }
  });
  it("keeps a committed withdrawal receipt when optional upload retirement fails", async () => {
    const f = await fixture();
    try {
      f.retirePrompt.mockImplementation(() => { throw new Error("optional cleanup unavailable"); });
      f.agent.inbox.nextTurn.push({ id: "remove", source: { kind: "user", rpcId: f.sourceRpcId } });
      expect(await f.host.request("cancel-prompt", { sessionId: f.agent.id, sourceRpcId: f.sourceRpcId })).toEqual({ outcome: "removed" });
      expect(f.agent.inbox.nextTurn).toEqual([]);
    } finally { await f.close(); }
  });
  it("registers only in the target agent, resolves logged native calls, and cleans replacements once", async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toEqual({ installed: true });
      expect(await f.run()).toEqual({ text: "receipt" });
      expect(f.call).toHaveBeenCalledWith("call", expect.objectContaining({ sessionId: f.agent.id, sourceRpcId: f.sourceRpcId, callId: "call1", name: "app_send_file", arguments: f.args }), expect.any(AbortSignal));
      await f.install(); expect(f.remove).not.toHaveBeenCalled();
      f.agent.status = "running"; expect(await f.install("changed")).toEqual({ installed: false });
      f.agent.status = "idle"; expect(await f.install("changed")).toEqual({ installed: true }); expect(f.remove).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
    expect(f.remove).toHaveBeenCalledTimes(2); expect(f.definitions.size).toBe(0);
  });
  it("ignores native policy/context notices queued before the actual user prompt", async () => {
    const f = await fixture();
    try {
      for (const kind of ["user-approval", "runtime-context", "agent-instructions", "skill-catalog", "working-directory"]) f.events.splice(1, 0, { type: "user/message", seq: 0, data: { source: { kind } } });
      f.events.forEach((event, index) => { event.seq = index; });
      await f.install(); expect(await f.run()).toEqual({ text: "receipt" });
      expect(f.call).toHaveBeenCalledWith("call", expect.objectContaining({ sourceRpcId: f.sourceRpcId }), expect.any(AbortSignal));
    } finally { await f.close(); }
  });
  it.each(["subagent", "goal", "ended", "closed-step", "stale-root", "changed-args", "duplicate-root", "finished-root", "cancelled"])("rejects %s before crossing the private pipe", async (scenario) => {
    const f = await fixture();
    try {
      await f.install(); let exec = f.exec, args: unknown = f.args;
      if (scenario === "subagent") exec = { ...exec, agent: { ...f.agent } };
      if (scenario === "goal") f.events[1]!.data.source = { kind: "goal", rpcId: f.sourceRpcId };
      if (scenario === "ended") f.events.push({ seq: 4, type: "turn/end", data: { turn: 1 } });
      if (scenario === "closed-step") f.events.push({ seq: 4, type: "step/end", data: { turn: 1, step: 1 } });
      if (scenario === "stale-root") f.events.push({ seq: 4, type: "turn/start", data: { turn: 2 } }, { seq: 5, type: "user/message", data: { source: { kind: "user", rpcId: randomUUID() } } }, { seq: 6, type: "step/start", data: { turn: 2, step: 1 } });
      if (scenario === "changed-args") args = { ...f.args, path: "/other" };
      if (scenario === "duplicate-root") f.events.push({ ...f.events[3]!, seq: 4 });
      if (scenario === "finished-root") f.events.push({ seq: 4, type: "tool/result", data: { message: { source: { callId: "call1" } } } });
      if (scenario === "cancelled") f.controller.abort();
      await expect(f.run(exec, args)).rejects.toThrow(); expect(f.call).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("accepts logged PTC dispatch ancestry and refuses missing or settled child calls", async () => {
    const f = await fixture();
    try {
      await f.install(); f.events[3]!.data.name = "run_code";
      const exec = { ...f.exec, callId: "call1:ptc:1", parent: {} };
      await expect(f.run(exec)).rejects.toThrow();
      f.events.push({ seq: 4, type: "tool/ptc-dispatch-start", data: { rootCallId: "call1", parentCallId: "call1", subCallId: exec.callId, name: "app_send_file", arguments: f.args } });
      expect(await f.run(exec)).toEqual({ text: "receipt" });
      f.events.push({ seq: 5, type: "tool/ptc-dispatch", data: { subCallId: exec.callId } });
      await expect(f.run(exec)).rejects.toThrow(); expect(f.call).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it("rolls back a failed lifecycle registration and uninstalls tools when the pipe closes", async () => {
    const f = await fixture();
    try {
      const effect = f.agent.ctx.effect;
      f.agent.ctx.effect = () => { throw new Error("agent disposed"); };
      expect(await f.install()).toEqual({ installed: false }); expect(f.definitions.size).toBe(0);
      f.agent.ctx.effect = effect;
      expect(await f.install()).toEqual({ installed: true }); expect(f.definitions.size).toBe(1);
      f.host.close(); await vi.waitFor(() => expect(f.definitions.size).toBe(0));
    } finally { await f.close(); }
    expect(f.remove).toHaveBeenCalledTimes(2);
  });
});

describe("DeepSeek App native execution boundary", () => {
  function fixture() {
    const input = new PassThrough(), output = new PassThrough(), toolsCall = vi.fn<AppPlatformTools["call"]>(async () => ({ text: '{"delivered":true}' }));
    const tools: AppPlatformTools = { definitions: [{ name: "app_send_file", description: "send", inputSchema: { type: "object" } }], instructions: "native", register: async () => {}, isRegistered: async () => false, call: toolsCall };
    const host = new DeepSeekAppTools(input, output), installs = vi.fn(async () => ({ installed: true }));
    const plugin = new NativeAppPipe(output, input, installs), signal = new AbortController(), sourceRpcId = randomUUID();
    const request = { sessionId: "native-session", sourceRpcId, callId: "native-call", rootCallId: "native-call", name: "app_send_file", arguments: { path: "/workspace/a.txt", kind: "file" } };
    return { host, plugin, installs, tools, toolsCall, signal, sourceRpcId, request, close: () => { host.close(); plugin.close(); } };
  }
  it("reports an already closed steering pipe as unsupported before dispatch", async () => {
    const f = fixture();
    try {
      f.host.close();
      expect(await f.host.steerPrompt({ sessionId: "native-session", sourceRpcId: f.sourceRpcId, requestId: randomUUID(), expectedTurn: 1, text: "never sent", clientTimeZone: "Asia/Shanghai" })).toEqual({ outcome: "unsupported" });
      expect(f.installs).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("binds native prompt/session identity, deduplicates calls and revokes on turn end", async () => {
    const f = fixture(), activity = vi.fn();
    try {
      expect(await f.plugin.request("call", f.request)).toMatchObject({ isError: true });
      expect(await f.host.install({ sessionId: "native-session", sourceRpcId: f.sourceRpcId, tools: f.tools, signal: f.signal.signal, onActivity: activity })).toBe(true);
      for (const mutation of [{ sessionId: "other" }, { sourceRpcId: randomUUID() }, { name: "other_tool" }]) expect(await f.plugin.request("call", { ...f.request, ...mutation })).toMatchObject({ isError: true });
      const results = await Promise.all([f.plugin.request("call", f.request), f.plugin.request("call", f.request)]);
      expect(results).toEqual([{ text: '{"delivered":true}' }, { text: '{"delivered":true}' }]); expect(f.toolsCall).toHaveBeenCalledTimes(1);
      expect(f.toolsCall).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "native-session", callId: "native-call", arguments: f.request.arguments }));
      expect(await f.plugin.request("call", { ...f.request, arguments: { path: "/other" } })).toMatchObject({ isError: true });
      f.signal.abort(); expect(await f.plugin.request("call", { ...f.request, callId: "late" })).toMatchObject({ isError: true });
      expect(f.toolsCall).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
  it("forwards native cancellation and real progress; old work cannot keep a new turn alive", async () => {
    const f = fixture(), progress = vi.fn(), cancel = new AbortController(); let call: Parameters<AppPlatformTools["call"]>[0] | undefined;
    f.toolsCall.mockImplementation(async (input) => { call = input; await new Promise<void>((resolve) => input.abortSignal.addEventListener("abort", () => resolve(), { once: true })); return { text: "cancelled" }; });
    try {
      await f.host.install({ sessionId: "native-session", sourceRpcId: f.sourceRpcId, tools: f.tools, signal: f.signal.signal, onActivity: progress });
      const pending = f.plugin.request("call", f.request, cancel.signal); const rejected = expect(pending).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(call).toBeDefined()); call!.onActivity?.(); expect(progress).toHaveBeenCalledTimes(1);
      cancel.abort(); await rejected; await vi.waitFor(() => expect(call!.abortSignal.aborted).toBe(true));
      call!.onActivity?.(); expect(progress).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
});
