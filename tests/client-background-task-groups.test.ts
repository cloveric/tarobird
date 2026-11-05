import { describe, expect, it } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import type { RunSummary } from "../src/client-protocol/run.js";
import { groupBackgroundTasks, groupElapsed, taskCounts, visibleTaskIds } from "../client/src/background-task-groups.js";
function task(id: string, phase: RunSummary["phase"] = "working", groupId = "round_a"): Message {
  return { id, conversationId: "chat", authorType: "bot", authorId: "bot", replyTo: "prompt", version: 1, createdAt: 1000, status: "complete", blocks: [{ type: "card", elements: [{ type: "markdown", text: "独立公开内容" }], extra: {
    backgroundTask: { version: 1, origin: "bound" }, backgroundTaskGroup: { version: 1, groupId, scopeId: id, runId: `run_${id}` },
    scopedRun: { version: 1, id: `run_${id}`, revision: 1, phase, startedAt: 1000, updatedAt: 2000, ...(["done", "error", "interrupted", "partial"].includes(phase) ? { endedAt: 2000 } : {}), count: 2, completed: 1, failed: 0, truncated: false },
  } }] };
}
describe("background task presentation projection", () => {
  it("keeps late running members in the bounded five-row preview", () => {
    const group = groupBackgroundTasks([...Array.from({ length: 5 }, (_, i) => task(String(i), "done")), task("late")]).groups[0]!;
    expect(visibleTaskIds(group).size).toBe(5);
    expect(visibleTaskIds(group).has("late")).toBe(true);
  });
  it("merges one parent turn without changing durable messages or their contents", () => {
    const original = [task("a"), task("b"), task("c", "done")], copy = structuredClone(original);
    const result = groupBackgroundTasks(original);
    expect(result.messages.map(m => m.id)).toEqual(["a"]); expect(result.groups[0]?.tasks.map(t => t.message.id)).toEqual(["a", "b", "c"]);
    expect(taskCounts(result.groups[0]!)).toEqual({ running: 2, done: 1, error: 0, interrupted: 0, unknown: 0 });
    expect(result.anchors.get("c")).toBe("a"); expect(original).toEqual(copy);
  });
  it("keeps later rounds, different bots, conversations and parent requests separate", () => {
    const result = groupBackgroundTasks([task("a"), task("b", "working", "round_b"), { ...task("c"), authorId: "other" }, { ...task("d"), conversationId: "other" }, { ...task("e"), replyTo: "other" }]);
    expect(result.groups).toHaveLength(5);
  });
  it("reconstructs completed, failed, interrupted and uncertain counts from persisted snapshots", () => {
    const messages = [task("a", "done"), task("b", "error"), task("c", "interrupted"), task("d", "partial")];
    const afterReload = groupBackgroundTasks(JSON.parse(JSON.stringify(messages)));
    expect(taskCounts(afterReload.groups[0]!)).toEqual({ running: 0, done: 1, error: 1, interrupted: 1, unknown: 1 });
    expect(groupElapsed(afterReload.groups[0]!, 9999999)).toBe(1000);
    const allDone = groupBackgroundTasks([task("a", "done"), task("b", "done")]); expect(taskCounts(allDone.groups[0]!).running).toBe(0); expect(taskCounts(allDone.groups[0]!).done).toBe(2);
  });
  it("retains all old and unsupported records, malformed versions and mismatched run bindings", () => {
    const old = task("old"), malformed = task("bad"), wrong = task("wrong");
    delete (old.blocks[0] as any).extra.backgroundTaskGroup;
    (malformed.blocks[0] as any).extra.backgroundTaskGroup.version = 2;
    (wrong.blocks[0] as any).extra.backgroundTaskGroup.runId = "foreign";
    expect(groupBackgroundTasks([old, malformed, wrong]).groups).toHaveLength(0);
    const data = [task("a"), task("b")]; expect(groupBackgroundTasks(data, false).messages).toEqual(data);
  });
  it("never hides a main summary, attachments, forwarded records or unattributed sources", () => {
    const main = task("main"), files = task("files"), unknown = task("unknown"), forwarded = task("forwarded");
    (main.blocks[0] as any).extra.nativeRun = (main.blocks[0] as any).extra.scopedRun;
    files.blocks.push({ type: "text", text: "独立交付附件说明" });
    (unknown.blocks[0] as any).extra.backgroundTask.origin = "unattributed";
    forwarded.forwardedFrom = { messageId: "source", conversationId: "elsewhere" } as any;
    const data = [main, files, unknown, forwarded]; expect(groupBackgroundTasks(data).messages).toEqual(data); expect(groupBackgroundTasks(data).groups).toEqual([]);
  });
  it("refuses ambiguous scope duplicates and uses a surviving anchor after personal deletion", () => {
    const a = task("a"), b = task("b"); (b.blocks[0] as any).extra.backgroundTaskGroup.scopeId = "a";
    expect(groupBackgroundTasks([a, b]).groups).toEqual([]);
    expect(groupBackgroundTasks([task("b"), task("c")]).anchors.get("c")).toBe("b");
  });
  it("does not count unconfirmed delivery or recovery interruption as successful completion", () => {
    const a = task("a", "done"), b = { ...task("b"), status: "error" as const };
    (a.blocks[0] as any).extra.backgroundTask.delivery = "unconfirmed";
    expect(taskCounts(groupBackgroundTasks([a, b]).groups[0]!)).toEqual({ running: 0, done: 0, error: 0, interrupted: 1, unknown: 1 });
  });
});
