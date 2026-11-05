import { expect, it, vi } from "vitest";
import { agentBusConfigSchema, agentBusCreateSchema, agentBusUpdateSchema, agentBusStartSchema, agentBusDispatchSchema } from "../src/client-protocol/agent-bus.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { GatewayAgentBusRuns, observeAgentBusRun } from "../src/gateway/agent-bus.js";
import type { BusDelegateInput } from "../src/bus/bus-client.js";

const base = { name: "Research", mode: "chain", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] };
it("treats invisible-only optional role instructions as omitted on write while preserving historical content", () => {
  const config = { ...base, mode: "fan", coordinator: { botId: "alpha", instruction: "\u200b" }, members: [{ botId: "beta", instruction: " \u200c\u200d\u2060 " }, { botId: "alpha", instruction: "می‌خواهم 👨‍👩‍👧‍👦" }] };
  expect(agentBusConfigSchema.parse(config).coordinator.instruction).toBe("\u200b");
  for (const result of [agentBusCreateSchema.parse({ requestId: "create", config }).config, agentBusUpdateSchema.parse({ revision: "rev", config }).config]) {
    expect(result.coordinator.instruction).toBeUndefined();
    expect(result.members[0]!.instruction).toBeUndefined();
    expect(result.members[1]!.instruction).toBe(config.members[1]!.instruction);
  }
});
it("rejects invisible-only names and goals at admission without breaking historical config or meaningful Unicode", () => {
  for (const text of ["\u200b\u200b\u200b", " \u200c\u200d\u2060\ufe0f\u202e\u202c\n", "\u00ad\u034f\u115f\u1160"]) {
    const config = { ...base, name: text };
    expect(agentBusConfigSchema.safeParse(config).success).toBe(true); // Existing records remain readable/repairable.
    expect(agentBusCreateSchema.safeParse({ requestId: "create", config }).success).toBe(false);
    expect(agentBusUpdateSchema.safeParse({ revision: "rev", config }).success).toBe(false);
    expect(agentBusStartSchema.safeParse({ requestId: "run", revision: "rev", text }).success).toBe(false);
  }
  for (const text of ["👨‍👩‍👧‍👦", "می‌خواهم", "请检查\u200b这段\n内容", "a\u00adb"]) {
    expect(agentBusStartSchema.parse({ requestId: "run", revision: "rev", text }).text).toBe(text);
    expect(agentBusCreateSchema.parse({ requestId: "create", config: { ...base, name: text } }).config.name).toBe(text);
  }
});
it("validates per-slot tasks while keeping old definitions unchanged", () => {
  expect(agentBusConfigSchema.parse(base).members[0]).toEqual({ botId: "beta" });
  const config = agentBusConfigSchema.parse({ ...base, members: [{ botId: "alpha", instruction: "  research  " }, { botId: "beta", instruction: "valuation" }] });
  expect(config.members.map(m => m.instruction)).toEqual(["research", "valuation"]);
  expect(() => agentBusConfigSchema.parse({ ...base, members: [{ botId: "beta", instruction: "x".repeat(8001) }] })).toThrow();
  expect(() => agentBusConfigSchema.parse({ ...base, coordinator: { botId: "alpha", instruction: "not a step" } })).toThrow();
  expect(agentBusConfigSchema.parse({ ...base, mode: "verify", coordinator: { botId: "alpha", instruction: "answer" } }).coordinator.instruction).toBe("answer");
});

const dispatch = { runId: "abr_run", workspaceId: "ab_ws", mode: "fan" as const, members: ["beta", "beta"], coordinatorConversationId: "source", conversations: ["first", "second"], maxResearchQuestions: 5, maxRevisionRounds: 1 };
it("rejects instruction arrays without exact, trusted conversation bindings", () => {
  expect(agentBusDispatchSchema.parse({ ...dispatch, instructions: ["research", "value"] }).instructions).toEqual(["research", "value"]);
  for (const change of [{ instructions: ["only one"] }, { instructions: ["research", "value"], conversations: undefined, coordinatorConversationId: undefined }, { mode: "chain", coordinatorInstruction: "ignored" }]) {
    expect(() => agentBusDispatchSchema.parse({ ...dispatch, ...change })).toThrow();
  }
});

it("binds tasks to repeated Bot slots despite out-of-order execution and completion", async () => {
  const reports: any[] = [], calls: BusDelegateInput[] = [], finish: (() => void)[] = [];
  const delegate = vi.fn(async (args: BusDelegateInput) => { calls.push(args); await new Promise<void>(r => finish.push(r)); return { success: true, text: args.prompt, fromInstance: "beta" }; });
  const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "coordinator result" })) };
  const observed = observeAgentBusRun({ transport: { enqueue: (_m, p) => { reports.push(p); return { persisted: Promise.resolve(), response: Promise.resolve(null) }; } },
    runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run", dispatch: { ...dispatch, instructions: ["research-only", "valuation-only"], coordinatorInstruction: "coordinator-only" },
    runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } }), bridge });
  const wrapped = observed.runtime.busRuntime!.delegateToInstance!, args = { fromInstance: "alpha", targetInstance: "beta", prompt: "shared-background", depth: 0, stateDir: "/unused" };
  const second = wrapped({ ...args, agentBusMemberIndex: 1 }), first = wrapped({ ...args, agentBusMemberIndex: 0 });
  expect(calls[0]!.prompt).toContain("valuation-only"); expect(calls[0]!.prompt).not.toContain("research-only");
  expect(calls[1]!.prompt).toContain("research-only"); expect(calls[1]!.prompt).not.toContain("valuation-only");
  finish[1]!(); await first; finish[0]!(); await second;
  await observed.bridge.handleAuthorizedMessage({ chatId: 1, userId: 1, chatType: "bus", locale: "en", text: "shared-background", files: [] });
  expect(bridge.handleAuthorizedMessage.mock.calls[0]![0].text).toContain("coordinator-only");
  expect(reports.filter(p => p.type === "stage.started").slice(0, 2).map(p => [p.conversationId, p.prompt])).toEqual([["second", calls[0]!.prompt], ["first", calls[1]!.prompt]]);
  observed.runtime.busRuntime!.agentBusRun!.outcome("success"); await observed.finish();
});

it("keeps old member prompts byte-for-byte unchanged when no instruction is configured", async () => {
  const delegate = vi.fn(async (_args: BusDelegateInput) => ({ success: true, text: "ok", fromInstance: "beta" }));
  const observed = observeAgentBusRun({ transport: { enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }) }, runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run", dispatch,
    runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } }), bridge: { handleAuthorizedMessage: vi.fn() } });
  const prompt = " 原始问题\n\n上一阶段（alpha）输出：\n$50 和中文\n ";
  await observed.runtime.busRuntime!.delegateToInstance!({ fromInstance: "alpha", targetInstance: "beta", prompt, depth: 0, stateDir: "/unused", agentBusMemberIndex: 0 });
  expect(delegate.mock.calls[0]![0].prompt).toBe(prompt); await observed.finish();
});

it.each(["/compact", "  /review this change\nwith details", "/stop"])("keeps Agent Bus goal %s out of native command branches for both members and coordinators", async prompt => {
  const delegate = vi.fn(async (_args: BusDelegateInput) => ({ success: true, text: "ok", fromInstance: "beta" }));
  const bridge = { handleAuthorizedMessage: vi.fn(async (_turn: any) => ({ text: "ok" })) };
  const observed = observeAgentBusRun({ transport: { enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }) }, runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run", dispatch,
    runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } }), bridge });
  await observed.runtime.busRuntime!.delegateToInstance!({ fromInstance: "alpha", targetInstance: "beta", prompt, depth: 0, stateDir: "/unused", agentBusMemberIndex: 0 });
  await observed.bridge.handleAuthorizedMessage({ chatId: 1, userId: 1, chatType: "bus", locale: "en", text: prompt, files: [] });
  for (const text of [delegate.mock.calls[0]![0].prompt, bridge.handleAuthorizedMessage.mock.calls[0]![0].text]) {
    expect(text.trimStart().startsWith("/")).toBe(false);
    expect(text.endsWith(prompt)).toBe(true);
  }
  await observed.finish();
});
