import { expect, it } from "vitest";
import { shareDirectory } from "../src/share-directory.js";
import type { HostDirectory } from "../src/HostApp.js";

function fixture(): HostDirectory {
  return { conversations: [{ id: "a", title: "Chat", type: "direct", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 }],
    activity: { a: { preview: "old", at: 1, unread: { message: 1 }, lastContentSeq: 1 } }, pins: ["a"],
    bots: [{ id: "bot", name: "Worker", online: 1, engine: "claude", model: "opus", effort: "high" }] };
}
it("preserves stable membership and profiles when only the stream preview changes", () => {
  const previous = fixture(), next = structuredClone(previous);
  next.activity.a!.preview = "new"; next.activity.a!.lastContentSeq = 2;
  const result = shareDirectory(previous, next);
  expect(result).toEqual(next); expect(result).not.toBe(previous);
  expect(result.conversations).toBe(previous.conversations); expect(result.bots).toBe(previous.bots); expect(result.pins).toBe(previous.pins);
  expect(result.activity.a!.unread).toBe(previous.activity.a!.unread);
  expect(previous.activity.a!.preview).toBe("old");
  expect(shareDirectory(result, structuredClone(result))).toBe(result);
});
it("publishes ownership, membership, binding, archive and removal changes without retaining old authority", () => {
  const previous = fixture(), next = structuredClone(previous);
  Object.assign(next.conversations[0]!, { ownerId: "other", botIds: ["second"], sessionId: "session", bindingId: "binding", archived: true });
  delete next.activity.a; next.pins = []; next.bots = [];
  const result = shareDirectory(previous, next);
  expect(result).toEqual(next); expect(result.conversations[0]).not.toBe(previous.conversations[0]);
  expect(previous.activity.a).toBeDefined(); expect(previous.pins).toEqual(["a"]);
});
it("keeps ordering, new fields and prototype-like record keys as ordinary data", () => {
  const previous = fixture(), next = structuredClone(previous);
  next.conversations.push({ ...next.conversations[0]!, id: "b", botIds: ["second", "bot"] });
  const first = shareDirectory(previous, next), reordered = structuredClone(first);
  reordered.conversations.reverse(); reordered.conversations[0]!.botIds.reverse();
  const result = shareDirectory(first, reordered);
  expect(result).toEqual(reordered); expect(result).not.toBe(first);
  const keyed = fixture(); keyed.activity = JSON.parse('{"__proto__":{"preview":"safe","at":0,"unread":{},"lastContentSeq":0}}');
  expect(Object.hasOwn(shareDirectory(previous, keyed).activity, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(shareDirectory(previous, keyed).activity)).toBe(Object.prototype);
});
it("publishes global pin changes while preserving independent group pins and stable directory data", () => {
  const previous = fixture(), next = structuredClone(previous);
  next.globalPins = ["a"];
  const result = shareDirectory(previous, next);
  expect(result).not.toBe(previous);
  expect(result.globalPins).toEqual(["a"]);
  expect(result.pins).toBe(previous.pins);
  expect(result.conversations).toBe(previous.conversations);
  expect(shareDirectory(result, structuredClone(result))).toBe(result);
  const unpinned = shareDirectory(result, { ...result, globalPins: [] });
  expect(unpinned.globalPins).toEqual([]);
  expect(unpinned.pins).toBe(previous.pins);
  expect(result.globalPins).toEqual(["a"]);
});
