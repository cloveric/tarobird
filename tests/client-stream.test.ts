import { describe, expect, it } from "vitest";
import { type Message } from "../src/client-protocol/index.js";
import { applyMessageDelta, messageDelta, messageStreamSchema } from "../src/client-protocol/stream.js";

const base: Message = { id: "message", conversationId: "conversation", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: "start " }], status: "streaming", version: 1, createdAt: 1 };
describe("versioned message stream operations", () => {
  it("appends text and replaces changed blocks without mutating the base", () => {
    const previous: Message = { ...base, blocks: [...base.blocks, { type: "run", phase: "working", elapsedMs: 0, tools: [], todos: [] }] };
    const next: Message = { ...previous, version: 2, blocks: [{ type: "text", text: "start 完整文本 🐻" }, { type: "run", phase: "working", elapsedMs: 500, tools: [], todos: [] }] };
    const delta = messageDelta(previous, next)!;
    expect(delta.ops.map((op) => op.op)).toEqual(["appendText", "replaceBlock"]);
    expect(applyMessageDelta(previous, delta)).toEqual(next); expect(previous.blocks[0]).toEqual(base.blocks[0]);
  });
  it("appends nested card text while preserving layout, actions and sibling changes", () => {
    const previous: Message = { ...base, blocks: [{ type: "card", title: "Working", template: "blue", elements: [{ type: "collapsible", open: true, text: "Thinking", children: [{ type: "markdown", text: "Thought ".repeat(10_000) }] }, { type: "button", text: "Stop", actionId: "stop", style: "danger" }] }] };
    const next = structuredClone(previous); next.version = 3;
    const card = next.blocks[0]!; if (card.type !== "card") throw new Error("card_expected");
    card.elements[0]!.children![0]!.text += "new detail"; card.elements[1]!.disabled = true;
    const delta = messageDelta(previous, next)!;
    expect(delta.ops).toEqual([{ op: "appendText", block: 0, path: [0, 0], text: "new detail" }, { op: "replaceElement", block: 0, path: [1], value: card.elements[1] }]);
    expect(JSON.stringify(delta).length).toBeLessThan(400); expect(applyMessageDelta(previous, delta)).toEqual(next);
  });
  it("negotiates card metadata patches and reconstructs every revision exactly", () => {
    let previous: Message = { ...base, blocks: [{ type: "card", title: "Working", extra: { nativeRun: { revision: 0 } }, elements: [{ type: "markdown", text: "正文 🐻\n".repeat(10000) }] }] };
    for (let revision = 1; revision <= 30; revision++) {
      const next = structuredClone(previous); next.version++;
      const card = next.blocks[0]!; if (card.type !== "card") throw new Error("card_expected");
      card.elements[0]!.text += `新增 ${revision}\n`;
      if (revision % 3) card.extra = { nativeRun: { revision, phase: "answering" }, unknownFutureField: ["preserved"] };
      else delete card.extra;
      const oldDelta = messageDelta(previous, next);
      expect(oldDelta?.ops.some(op => op.op === "replaceCardExtra")).not.toBe(true);
      if (oldDelta) expect(applyMessageDelta(previous, oldDelta)).toEqual(next);
      const delta = messageDelta(previous, next, { cardExtra: true })!;
      expect(delta.ops.map(op => op.op)).toEqual(["replaceCardExtra", "appendText"]);
      expect(JSON.stringify(delta).length).toBeLessThan(500);
      const updated = applyMessageDelta(previous, delta);
      expect(updated).toEqual(next); expect(applyMessageDelta(updated, delta)).toBe(updated);
      previous = updated;
    }
    expect(() => applyMessageDelta(base, { messageId: base.id, baseVersion: 1, version: 2, ops: [{ op: "replaceCardExtra", block: 0, value: {} }] })).toThrow("stream_card_required");
    expect(messageDelta(previous, { ...previous, version: previous.version + 1, status: "complete" }, { cardExtra: true })).toBeUndefined();
  });
  it("uses full snapshots for terminal updates, new metadata and block structure changes", () => {
    expect(messageDelta(base, { ...base, status: "complete", version: 2 })).toBeUndefined();
    expect(messageDelta(base, { ...base, replyTo: "reply", version: 2 })).toBeUndefined();
    expect(messageDelta(base, { ...base, blocks: [], version: 2 })).toBeUndefined();
    expect(messageDelta(base, base)).toBeUndefined();
  });
  it("ignores stale versions, requires the exact base and refuses invalid operation paths", () => {
    const delta = { messageId: base.id, baseVersion: 1, version: 2, ops: [{ op: "appendText", block: 0, text: "next" }] };
    const applied = applyMessageDelta(base, delta); expect(applyMessageDelta(applied, delta)).toBe(applied);
    expect(() => applyMessageDelta(base, { ...delta, baseVersion: 2, version: 3 })).toThrow("stream_base_mismatch");
    expect(() => applyMessageDelta(base, { ...delta, messageId: "different" })).toThrow("stream_message_mismatch");
    expect(() => applyMessageDelta(base, { ...delta, ops: [{ op: "appendText", block: 2, text: "bad" }] })).toThrow("stream_block_missing");
    expect(() => applyMessageDelta(base, { ...delta, ops: [{ op: "appendText", block: 0, path: [0], text: "bad" }] })).toThrow("stream_card_required");
    for (const path of [["__proto__"], [-1], [1.5], Array(33).fill(0)]) expect(messageStreamSchema.safeParse({ ...delta, ops: [{ op: "appendText", block: 0, path, text: "bad" }] }).success).toBe(false);
    expect(messageStreamSchema.safeParse({ ...delta, version: 1 }).success).toBe(false);
  });
});
