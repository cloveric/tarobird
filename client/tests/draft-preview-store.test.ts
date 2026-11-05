import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DraftPreview } from "../src/storage.js";
import { createDraftPreviewStore, listDraftPreview, samePreviews } from "../src/DraftPreview.js";

type Previews = Record<string, DraftPreview>;
function fixture(initial: Previews) {
  let value = initial, changed: (() => void) | undefined;
  const reads: Array<(result: Previews) => void> = [];
  const cache = {
    draftPreviews: vi.fn(() => new Promise<Previews>(resolve => reads.push(() => resolve({ ...value })))),
    subscribeDrafts: vi.fn((listener: () => void) => { changed = listener; return () => { changed = undefined; }; }),
  };
  return {
    cache, set: (next: Previews) => { value = next; },
    change: () => changed?.(),
    /** Completes the oldest outstanding read and lets the store process it. */
    settle: async () => { reads.shift()?.(value); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    pending: () => reads.length,
  };
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the snapshot and does not notify when a saved draft leaves previews unchanged", async () => {
  const io = fixture({ chat: { text: "hello", files: 0, reply: false } });
  const store = createDraftPreviewStore(io.cache), notify = vi.fn();
  store.subscribe(notify);
  await io.settle();
  const first = store.getSnapshot();
  expect(first.chat?.text).toBe("hello"); expect(notify).toHaveBeenCalledTimes(1);
  io.change(); await io.settle();
  expect(store.getSnapshot()).toBe(first); expect(notify).toHaveBeenCalledTimes(1);
  io.set({ chat: { text: "hello world", files: 0, reply: false } }); io.change(); await io.settle();
  expect(store.getSnapshot().chat?.text).toBe("hello world"); expect(notify).toHaveBeenCalledTimes(2);
});

it("coalesces bursts of draft changes into one trailing read with the latest value", async () => {
  const io = fixture({});
  const store = createDraftPreviewStore(io.cache);
  store.subscribe(() => {});
  await io.settle();
  // Twenty saves while one read is outstanding: one read now, one trailing read.
  io.set({ chat: { text: "a", files: 0, reply: false } }); io.change();
  for (let i = 0; i < 20; i++) { io.set({ chat: { text: `typed ${i}`, files: 0, reply: false } }); io.change(); }
  expect(io.pending()).toBe(1);
  await io.settle(); expect(io.pending()).toBe(1);
  await io.settle(); expect(io.pending()).toBe(0);
  expect(io.cache.draftPreviews).toHaveBeenCalledTimes(3);
  expect(store.getSnapshot().chat?.text).toBe("typed 19");
});

it("stops observing after the last subscriber leaves", async () => {
  const io = fixture({});
  const store = createDraftPreviewStore(io.cache);
  const leave = store.subscribe(() => {});
  await io.settle(); leave();
  io.change(); expect(io.pending()).toBe(0);
});

it("compares previews by content and resolves a row's own preview text", () => {
  expect(samePreviews({ a: { text: "x", files: 1, reply: false } }, { a: { text: "x", files: 1, reply: false } })).toBe(true);
  expect(samePreviews({ a: { text: "x", files: 1, reply: false } }, { a: { text: "x", files: 2, reply: false } })).toBe(false);
  expect(samePreviews({ a: { text: "x", files: 0, reply: false } }, {})).toBe(false);
  const group = { id: "g", type: "group", title: "群", ownerId: "o", botIds: [], archived: false, createdAt: 1 } as const;
  const topic = { ...group, id: "t", type: "group", title: "话题", parentId: "g" } as const;
  expect(listDraftPreview(group, [group, topic], { t: { text: "草稿内容", files: 0, reply: false } }, true)).toContain("草稿内容");
  expect(listDraftPreview(group, [group, topic], { t: { text: "草稿内容", files: 0, reply: false } }, false)).toBeUndefined();
});
