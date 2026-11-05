import { describe, it, expect } from "vitest";
import { ClaudeScopedEvents } from "../src/codex/claude-scoped-events.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";

function fixture() {
  const events: EngineStreamEvent[] = [];
  const owner = { emit: (event: EngineStreamEvent) => { events.push(event); }, turnId: 1, origin: "bound" as const };
  const tracker = new ClaudeScopedEvents({ sanitize: text => text, flatten: content => String(content), evidence: () => ({}) });
  return { events, owner, tracker };
}
describe("Claude public scoped events", () => {
  it("isolates interleaved tool IDs, retains line breaks and keeps the main phase and counts", async () => {
    const { events, owner, tracker } = fixture();
    const one = tracker.registerDelegate("one", "Agent", {}, owner)!;
    const two = tracker.registerDelegate("two", "Agent", {}, owner)!;
    for (const state of [one, two]) tracker.accept(state, { type: "assistant", message: { content: [{ type: "thinking", thinking: "Line one\n\nLine two" }, { type: "tool_use", name: "Read", id: "same", input: {} }] } });
    tracker.accept(one, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "same", content: "one" }] } });
    const record = createRunRecord(); recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "same" });
    for (const event of events) recordRunEvent(record, event);
    expect(record.phase).toBe("working");
    expect(record.entries.find(e => e.scope?.id === one.scope.id && e.kind === "thinking")?.text).toBe("Line one\n\nLine two");
    expect(record.entries.find(e => e.scope?.id === one.scope.id && e.callId === "same")?.status).toBe("done");
    expect(record.entries.find(e => e.scope?.id === two.scope.id && e.callId === "same")?.status).toBe("running");
    expect(record.entries.find(e => !e.scope && e.callId === "same")?.status).toBe("running");
    expect(summarizeRun(record, "running")).toMatchObject({ count: 1, completed: 0, phase: "working", current: { name: "Bash" } });
    await tracker.close();
  });
  it("deduplicates frames and partial/full blocks without publishing child instructions", async () => {
    const { events, owner, tracker } = fixture(); const child = tracker.registerDelegate("agent", "Agent", {}, owner)!;
    tracker.accept(child, { type: "user", message: { content: [{ type: "text", text: "PRIVATE ASSIGNMENT" }] } });
    tracker.accept(child, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    tracker.accept(child, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Public\n" } } });
    const frame = { type: "assistant", uuid: "frame", message: { content: [{ type: "thinking", thinking: "Public\nthought" }] } };
    tracker.accept(child, frame); tracker.accept(child, frame);
    const record = createRunRecord(); for (const event of events) recordRunEvent(record, event);
    expect(record.entries.filter(e => e.kind === "thinking").map(e => e.text)).toEqual(["Public\nthought"]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE ASSIGNMENT");
    await tracker.close();
  });
  it("fails closed on ambiguous parent IDs and keeps nested scopes under the original owner", async () => {
    const { events, owner, tracker } = fixture(); const one = tracker.registerDelegate("same", "Agent", {}, owner)!;
    tracker.registerDelegate("same", "Agent", {}, { ...owner, turnId: 2 });
    expect(tracker.findDelegate("same")).toBeUndefined();
    tracker.accept(one, { type: "assistant", message: { content: [{ type: "tool_use", id: "nested", name: "Agent", input: {} }] } });
    const nested = tracker.findDelegate("nested")!;
    expect(nested.scope.parentId).toBe(one.scope.id); expect(nested.rootScope?.id).toBe(one.scope.id);
    expect(tracker.startReview({ ...owner, origin: "unattributed" }, "unknown")).toBeUndefined();
    await tracker.close(); const count = events.length;
    tracker.accept(nested, { type: "assistant", message: { content: [{ type: "text", text: "late" }] } });
    expect(events).toHaveLength(count);
  });
  it("reserves capture budget for the main run and still closes captured child calls", () => {
    const record = createRunRecord(), scope = { id: "child", kind: "subagent" as const };
    for (let i = 0; i < 600; i++) recordRunEvent(record, { type: "scoped", scope, origin: "bound", event: { type: "tool_use", toolName: "Read", toolUseId: String(i), toolInput: "x".repeat(30000) } });
    expect(record.truncated).toBe(true); expect(record.entries.length).toBeLessThan(201);
    recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "main" });
    recordRunEvent(record, { type: "scoped", scope, origin: "bound", event: { type: "tool_result", toolUseId: "0", output: "x".repeat(90000) } });
    expect(record.entries.find(e => e.callId === "0")?.status).toBe("done");
    expect(record.entries.find(e => e.callId === "main")?.status).toBe("running");
    expect(summarizeRun(record, "running").count).toBe(1);
  });
  it("bounds concurrent scopes and preserves completion callbacks on shutdown", async () => {
    const { owner, tracker } = fixture();
    for (let i = 0; i < 128; i++) expect(tracker.registerDelegate(String(i), "Agent", {}, owner)).toBeDefined();
    expect(tracker.registerDelegate("overflow", "Agent", {}, owner)).toBeUndefined();
    await tracker.close(); expect(tracker.findDelegate("0")).toBeUndefined();
  });
});

it("keeps a detached nested Agent alive on an independent presentation root", async () => {
  const { events, owner, tracker } = fixture();
  const parent = tracker.registerDelegate("parent", "Agent", {}, owner)!;
  const child = tracker.registerDelegate("nested-detached", "Agent", { run_in_background: true }, owner, parent)!;
  expect(child.scope.parentId).toBe(parent.scope.id); expect(child.rootScope).toBeUndefined();
  await tracker.finish(parent, "done"); expect(child.closed).toBe(false);
  tracker.accept(child, { type: "assistant", message: { content: [{ type: "text", text: "late child progress" }] } });
  expect(events).toContainEqual(expect.objectContaining({ type: "scoped", scope: child.scope, detached: true, event: expect.objectContaining({ text: "late child progress" }) }));
  expect(tracker.registerDelegate("parent", "Agent", {}, { ...owner, turnId: 2 })).toBeUndefined();
  await tracker.close(); expect(child.closed).toBe(true);
});
it("does not chain completed token callbacks behind a blocked initial card send", async () => {
  const { tracker, owner } = fixture(); let release!:()=>void;
  const first = new Promise<void>(resolve => { release = resolve; }); let calls=0;
  const state = tracker.registerDelegate("slow", "Agent", {}, { ...owner, emit: () => ++calls === 1 ? first : undefined })!;
  for (let i=0;i<500;i++) tracker.emit(state, { type: "thinking", text: "x", delta: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(state.deliveries.size).toBe(1);
  release(); await tracker.close(); expect(state.deliveries.size).toBe(0);
});

it("releases synchronous nested delegates inside a long-running review", async () => {
  const { tracker, owner } = fixture(); const review = tracker.startReview(owner, "monitor")!;
  for (let i = 0; i < 150; i++) {
    const id = `sync-${i}`;
    tracker.accept(review, { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id, input: {} }] } });
    const child = tracker.findDelegate(id)!;
    expect(child).toBeDefined(); expect(child.background).toBe(true); expect(child.launchedDetached).toBe(false);
    tracker.accept(review, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] } });
    expect(child.closed).toBe(true);
  }
  expect(review.closed).toBe(false); await tracker.close();
});

it("does not write unattributed background lifecycle into the current run", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "background_task_started", taskId: "old", origin: "unattributed" });
  recordRunEvent(record, { type: "background_task_finished", taskId: "old", origin: "unattributed", status: "completed" });
  expect(record.entries).toEqual([]);
});

it("reconciles multiple streamed blocks by index without repeating completed text", async () => {
  const { tracker, owner, events } = fixture(); const child = tracker.registerDelegate("multiple", "Agent", {}, owner)!;
  const blocks = [{ type: "thinking", thinking: "First thought" }, { type: "text", text: "First answer" }, { type: "thinking", thinking: "Second thought" }, { type: "text", text: "Second answer" }];
  for (const [index, block] of blocks.entries()) {
    tracker.accept(child, { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: block.type } } });
    tracker.accept(child, { type: "stream_event", event: { type: "content_block_delta", index, delta: block.type === "thinking" ? { type: "thinking_delta", thinking: block.thinking } : { type: "text_delta", text: block.text } } });
  }
  tracker.accept(child, { type: "assistant", message: { content: blocks } });
  const texts = events.flatMap(e => e.type === "scoped" && (e.event.type === "thinking" || e.event.type === "assistant_text") ? e.event.text : []);
  expect(texts).toEqual(["First thought", "First answer", "Second thought", "Second answer"]);
  expect(child.partialBlocks.size).toBe(0); await tracker.close();
});
