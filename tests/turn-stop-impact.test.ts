import { expect, it } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import { affectedBackgroundTasks, turnStopImpact } from "../client/src/turn-stop.js";

const bots = [{ id: "claude", engine: "claude" as const }, { id: "codex", engine: "codex" as const }];
function message(id: string, bot: string, scoped = false, phase = "working", waiting = false): Message {
  return { id, conversationId: "chat", authorType: "bot", authorId: bot, status: "streaming", createdAt: 1, blocks: [{ type: "card", elements: [], extra: { [scoped ? "scopedRun" : "nativeRun"]: { version: 1, id, revision: 1, phase, startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false, ...(waiting ? { current: { seq: 1, revision: 1, at: 1, name: "background_review_wait", kind: "text", status: "waiting" } } : {}) } } }] } as Message;
}
it("does not mistake a streaming background scope for an active foreground reply", () => {
  expect(turnStopImpact([message("background", "claude", true)], bots, "chat")).toEqual({ risk: false, identity: "[]" });
});
it("limits the warning to the same Claude Bot and conversation", () => {
  const rows = [message("front", "claude"), message("background", "claude", true), message("other", "codex")];
  expect(turnStopImpact(rows, bots, "chat").risk).toBe(true);
  expect(turnStopImpact(rows, bots, "chat", "codex").risk).toBe(false);
  expect(turnStopImpact(rows, bots, "other").risk).toBe(false);
  expect(turnStopImpact([rows[0]!, message("background", "codex", true)], bots, "chat").risk).toBe(false);
});
it("keeps a conservative warning while waiting, because the prompt may start before the stop arrives", () => {
  expect(turnStopImpact([message("wait", "claude", false, "working", true)], bots, "chat").risk).toBe(true);
});
it("ends consent when the foreground changes, not when background reports update", () => {
  const rows = [message("front", "claude"), message("background", "claude", true)];
  const original = turnStopImpact(rows, bots, "chat");
  expect(turnStopImpact([rows[0]!, message("background-new", "claude", true)], bots, "chat").identity).toBe(original.identity);
  expect(turnStopImpact([message("next", "claude"), rows[1]!], bots, "chat").identity).not.toBe(original.identity);
  expect(turnStopImpact([message("front", "claude", false, "done"), rows[1]!], bots, "chat")).toEqual({ risk: false, identity: "[]" });
});

const busRecord = (): Message => ({ id: "bus_record", conversationId: "chat", authorType: "bot", authorId: "claude", status: "streaming", version: 1, createdAt: 1, blocks: [{ type: "card", elements: [], extra: { agentBusStage: { runId: "run_one", workspaceId: "bus_one", stageId: "s1", status: "running" } } }] });
it("does not target an independent Bus record or let its updates change foreground consent", () => {
  const record = busRecord();
  expect(turnStopImpact([record], bots, "chat")).toEqual({ risk: false, identity: "[]" });
  const ordinary: Message = { ...record, id: "ordinary", blocks: [{ type: "text", text: "普通回复" }] };
  expect(turnStopImpact([record, ordinary], bots, "chat")).toEqual(turnStopImpact([ordinary], bots, "chat"));
});
it("retains a genuine native foreground run even when its message also carries a Bus marker", () => {
  const native = message("front", "claude", false, "working", true);
  const mixed = { ...native, blocks: [...busRecord().blocks, ...native.blocks] };
  expect(turnStopImpact([mixed], bots, "chat")).toEqual(turnStopImpact([native], bots, "chat"));
  expect(turnStopImpact([mixed], bots, "chat").risk).toBe(true);
});


it("uses declared native stop scope and excludes completed and foreground steps", () => {
  const tasks = [
    { id: "agent", label: "Review", kind: "subagent" as const, mode: "background" as const, status: "running" as const, canStop: true, updatedAt: 1 },
    { id: "shell", label: "Command", kind: "shell" as const, mode: "background" as const, status: "running" as const, canStop: true, updatedAt: 1 },
    { id: "done", label: "Complete", kind: "subagent" as const, mode: "background" as const, status: "done" as const, canStop: false, updatedAt: 1 },
    { id: "child", label: "Read", kind: "subagent" as const, mode: "foreground" as const, status: "running" as const, canStop: false, parentId: "agent", updatedAt: 1 },
  ];
  expect(affectedBackgroundTasks({ supported: true, tasks, foregroundStopScope: "subagents" }).map(task => task.id)).toEqual(["agent"]);
  expect(affectedBackgroundTasks({ supported: true, tasks, foregroundStopScope: "all" }).map(task => task.id)).toEqual(["agent", "shell"]);
  for (const snapshot of [undefined, { supported: false, tasks }, { supported: true, tasks }, { supported: true, tasks, foregroundStopScope: "foreground" as const }]) expect(affectedBackgroundTasks(snapshot)).toEqual([]);
});
