import { expect, it } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import { shareMessages } from "../src/conversation-messages.js";

const message = (id: string, version: number, text = id, status: Message["status"] = "complete"): Message => ({
  id, conversationId: "chat", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text }], status, version, createdAt: 1,
});

it("keeps unchanged message objects across a full history reread", () => {
  const previous = [message("a", 1), message("b", 2), message("stream", 3, "partial", "streaming")];
  // A fresh IDB read: structurally equal copies plus one advanced stream version.
  const next = [message("a", 1), message("b", 2), message("stream", 4, "partial text", "streaming")];
  const shared = shareMessages(previous, next);
  expect(shared).not.toBe(previous);
  expect(shared[0]).toBe(previous[0]);
  expect(shared[1]).toBe(previous[1]);
  expect(shared[2]).toBe(next[2]);
  expect((shared[2]!.blocks[0] as { text: string }).text).toBe("partial text");
});

it("returns the previous array when nothing changed, so derived memos stay valid", () => {
  const previous = [message("a", 1), message("b", 1)];
  expect(shareMessages(previous, [message("a", 1), message("b", 1)])).toBe(previous);
});

it("adopts new objects for status changes, appended, removed and reordered messages", () => {
  const previous = [message("a", 1), message("b", 1, "b", "streaming")];
  const completed = shareMessages(previous, [message("a", 1), message("b", 1, "b", "complete")]);
  expect(completed[0]).toBe(previous[0]); expect(completed[1]).not.toBe(previous[1]);
  const appended = shareMessages(previous, [message("a", 1), message("b", 1, "b", "streaming"), message("c", 1)]);
  expect(appended).toHaveLength(3); expect(appended[0]).toBe(previous[0]); expect(appended[1]).toBe(previous[1]);
  const removed = shareMessages(previous, [message("b", 1, "b", "streaming")]);
  expect(removed).toEqual([previous[1]]); expect(removed).not.toBe(previous);
  const reordered = shareMessages(previous, [message("b", 1, "b", "streaming"), message("a", 1)]);
  expect(reordered).not.toBe(previous); expect(reordered.map(item => item.id)).toEqual(["b", "a"]);
});

it("never reuses an object across a version rollback or a different block count", () => {
  const previous = [message("a", 5)];
  expect(shareMessages(previous, [message("a", 4)])[0]).not.toBe(previous[0]);
  const extended: Message = { ...message("a", 5), blocks: [{ type: "text", text: "a" }, { type: "text", text: "more" }] };
  expect(shareMessages(previous, [extended])[0]).toBe(extended);
  expect(shareMessages([], [message("a", 1)])).toHaveLength(1);
});
