import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
import type { ClientCache, Identity } from "../src/storage.js";
import type { Message } from "../../src/client-protocol/index.js";

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html";
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url); await page.waitForFunction(() => "streamCache" in window); });

test("active-task recovery reads IDs without materializing 10,000 historical bodies", async ({ page }, info) => {
  const result = await page.evaluate(async () => {
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const request = indexedDB.open(cache.databaseName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = db.transaction("messages", "readwrite"), store = tx.objectStore("messages");
      const statuses = ["complete", "error", "deleted", "pending", "streaming"] as const;
      for (let i = 0; i < 10_000; i++) store.put({ id: `message-${String(i).padStart(5, "0")}`, conversationId: `chat-${i % 3}`, authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "x".repeat(2048) }], status: statuses[i < 9998 ? i % 3 : i - 9995], createdAt: i, version: 1 });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      // Count records returned by the value-reading IDB APIs used here; this
      // is an allocation-boundary check, not a native memory measurement.
      let valueRecords = 0;
      const restores: (() => void)[] = [];
      for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
        for (const method of ["get", "getAll", "openCursor"] as const) {
          const original = prototype[method];
          Object.assign(prototype, { [method]: function(this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
            const request = (original as Function).apply(this, args) as IDBRequest;
            if ((this instanceof IDBObjectStore ? this.name : this.objectStore.name) === "messages") request.addEventListener("success", () => {
              if (request.result) valueRecords += method === "getAll" ? request.result.length : 1;
            });
            return request;
          } });
          restores.push(() => Object.assign(prototype, { [method]: original }));
        }
      }
      try {
        const start = performance.now(), ids = await cache.activeMessages();
        return { ids, valueRecords, elapsedMs: performance.now() - start, historyRecords: 10_000, historicalTextBytes: 20_480_000 };
      } finally { restores.forEach(restore => restore()); }
    } finally { db.close(); }
  });
  console.log("Active task recovery read volume", JSON.stringify(result));
  await info.attach("active-recovery-read-volume", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.ids).toEqual(["message-09998", "message-09999"]);
  expect(result.valueRecords).toBe(0);
});

test("an aborted active-task read rejects once without an unhandled transaction rejection", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const unhandled: string[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => { unhandled.push(event.reason?.name ?? String(event.reason)); event.preventDefault(); };
    window.addEventListener("unhandledrejection", onUnhandled);
    const original = IDBIndex.prototype.getAllKeys;
    let injected = false;
    IDBIndex.prototype.getAllKeys = function(...args) {
      const request = original.apply(this, args);
      if (this.objectStore.name === "messages" && !injected) {
        injected = true; const transaction = this.objectStore.transaction;
        request.addEventListener("success", () => transaction.abort(), { once: true });
      }
      return request;
    };
    try {
      let failure = ""; try { await cache.activeMessages(); } catch (error) { failure = (error as Error).name; }
      // Let the browser dispatch rejected transaction promises after the read
      // rejection is already handled by its caller.
      await new Promise(resolve => setTimeout(resolve, 50));
      return { injected, failure, unhandled };
    } finally { IDBIndex.prototype.getAllKeys = original; window.removeEventListener("unhandledrejection", onUnhandled); }
  });
  expect(result).toEqual({ injected: true, failure: "AbortError", unhandled: [] });
});

test("version 7 upgrade preserves drafts, outbox and history and tracks later status changes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const Constructor = (window as unknown as { streamCache: ClientCache }).streamCache.constructor as typeof ClientCache;
    const name = "legacy-memory-migration", request = indexedDB.open(name, 7);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ["settings", "activity", "attachmentData", "attachmentMeta", "downloadMeta", "cursors", "syncState"]) db.createObjectStore(store);
      db.createObjectStore("conversations", { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("messages", { keyPath: "id" }).createIndex("conversation", "conversationId");
      db.createObjectStore("downloadChunks", { keyPath: ["attachmentId", "revision", "index"] }).createIndex("attachment", "attachmentId");
      db.createObjectStore("syncMessages", { keyPath: ["owner", "message.id"] }).createIndex("owner", "owner");
      const drafts = db.createObjectStore("conversationDrafts"); drafts.createIndex("size", "size"); drafts.createIndex("active", "active");
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const identity: Identity = { deviceId: "device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] };
    const original: Message = { id: "pending-old", conversationId: "chat", authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "keep history" }], status: "pending", createdAt: 1, version: 1 };
    const tx = db.transaction(["settings", "messages", "outbox", "conversationDrafts"], "readwrite");
    tx.objectStore("settings").put(identity, "identity"); tx.objectStore("settings").put("keep text", "draft:chat");
    tx.objectStore("messages").put(original); tx.objectStore("messages").put({ ...original, id: "complete-old", status: "complete" });
    tx.objectStore("outbox").put({ id: "queued", order: 1, frame: { v: 1, type: "message.send", conversationId: "chat", clientMsgId: "queued", text: "keep queued", attachments: [] } });
    tx.objectStore("conversationDrafts").put({ files: [{ bytes: new Uint8Array([0, 7, 255]).buffer, name: "saved.bin", type: "application/octet-stream", lastModified: 1 }], previewStyle: "card", size: 3, active: 1, revision: "saved-revision", owner: JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]) }, "chat");
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    const cache = new Constructor(name);
    try {
      const initial = await cache.activeMessages(), history = await cache.messages("chat"), saved = await cache.conversationDraft("chat", identity);
      await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: 1, kind: "message.updated", payload: { ...original, status: "complete", version: 2 }, at: 2 });
      const completed = await cache.activeMessages();
      await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: 2, kind: "message.created", payload: { ...original, id: "new-stream", status: "streaming", version: 1 }, at: 3 });
      return { initial, completed, current: await cache.activeMessages(), history: history.map(m => m.blocks), text: await cache.draft("chat"), revision: saved.revision, file: Array.from(new Uint8Array(await saved.draft.files[0]!.arrayBuffer())), outbox: (await cache.outbox()).map(m => m.id) };
    } finally { cache.close(); }
  });
  expect(result).toEqual({ initial: ["pending-old"], completed: [], current: ["new-stream"], history: [[{ type: "text", text: "keep history" }], [{ type: "text", text: "keep history" }]], text: "keep text", revision: "saved-revision", file: [0, 7, 255], outbox: ["queued"] });
});

test("large draft encodings are shared only while reading; completed and failed reads can be released", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const identity: Identity = { deviceId: "device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] }; await cache.initializeIdentity(identity);
    const file = new File([new Uint8Array(32 * 1024 * 1024).fill(7)], "large.bin"), read = file.arrayBuffer.bind(file);
    let reads = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    file.arrayBuffer = async () => { reads++; await barrier; return read(); };
    const draft = { files: [file], previewStyle: "card" as const };
    const first = cache.saveConversationDraft("one", draft, identity), second = cache.saveConversationDraft("two", draft, identity);
    const concurrentReads = reads; release(); await Promise.all([first, second]);
    const thirdRevision = await cache.saveConversationDraft("three", draft, identity);
    const completedReads = reads;
    const restored = await cache.conversationDraft("three", identity), bytes = new Uint8Array(await restored.draft.files[0]!.arrayBuffer());
    file.arrayBuffer = async () => { throw new DOMException("source changed", "NotReadableError"); };
    let rereadFailure = ""; try { await cache.saveConversationDraft("three", { ...draft, previewChoice: null }, identity, thirdRevision); } catch (error) { rereadFailure = (error as Error).name; }
    const afterFailure = await cache.conversationDraft("three", identity);
    const originalKept = afterFailure.revision === thirdRevision && afterFailure.draft.previewChoice === undefined && new Uint8Array(await afterFailure.draft.files[0]!.slice(0, 4).arrayBuffer()).every(byte => byte === 7);
    const failed = new File(["retry bytes"], "retry.txt"); let attempts = 0;
    failed.arrayBuffer = async () => { if (++attempts === 1) throw new Error("read failed"); return new TextEncoder().encode("retry bytes").buffer; };
    let failure = ""; try { await cache.saveConversationDraft("retry", { files: [failed], previewStyle: "card" }, identity); } catch (e) { failure = (e as Error).message; }
    await cache.saveConversationDraft("retry", { files: [failed], previewStyle: "card" }, identity);
    return { concurrentReads, completedReads, size: bytes.length, valid: bytes.every(byte => byte === 7), rereadFailure, originalKept, failure, attempts, retry: await (await cache.conversationDraft("retry", identity)).draft.files[0]!.text() };
  });
  expect(result).toEqual({ concurrentReads: 1, completedReads: 2, size: 32 * 1024 * 1024, valid: true, rereadFailure: "NotReadableError", originalKept: true, failure: "read failed", attempts: 2, retry: "retry bytes" });
});


test("clearing a sent draft refreshes previews without clearing a newer draft", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    await cache.saveDraft("reply-preview", "sent text");
    let changes = 0;
    const stop = cache.subscribeDrafts(() => { changes++; });
    try {
      await cache.clearDraftIfMatches("reply-preview", "sent text");
      const cleared = { changes, text: await cache.draft("reply-preview") };
      await cache.saveDraft("reply-preview", "newer text");
      changes = 0;
      await cache.clearDraftIfMatches("reply-preview", "sent text");
      return { cleared, preserved: { changes, text: await cache.draft("reply-preview") } };
    } finally { stop(); }
  });
  expect(result).toEqual({ cleared: { changes: 1, text: "" }, preserved: { changes: 0, text: "newer text" } });
});

test("in-flight messages() read cannot poison messageCache after forgetIdentity()", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const Constructor = (window as unknown as { ClientCache: typeof ClientCache }).ClientCache;
    const dbName = `epoch-race-${crypto.randomUUID()}`;
    const cache = new Constructor(dbName);
    try {
      await cache.saveIdentity({ deviceId: "d1", hubPublicKey: "h1", publicKey: "p1", name: "old", routes: [] });
      // 1 prior mutation advances the conversation epoch to 1 while global epoch is still 0.
      await cache.apply({
        v: 1, type: "event", conversationId: "secret-chat", seq: 1, kind: "message.created", at: 100,
        payload: { id: "m-secret", conversationId: "secret-chat", authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "TOP SECRET FROM OLD IDENTITY" }], status: "complete", createdAt: 100, version: 1 },
      });
      // Pause the messages() IDB read right before it finishes so forgetIdentity() races it.
      // Evict in-memory entry by closing & reopening? No: force a cold read on a fresh sibling or pause getAll on cache after clearing cache via a second mutation?
      // Better: open a fresh ClientCache on the same DB, apply seq 2 (so its local epoch is 1 while cache has nothing cached), then pause its IDB read!
      const reader = new Constructor(dbName);
      try {
        await reader.apply({
          v: 1, type: "event", conversationId: "secret-chat", seq: 2, kind: "message.updated", at: 101,
          payload: { id: "m-secret", conversationId: "secret-chat", authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "TOP SECRET FROM OLD IDENTITY" }], status: "complete", createdAt: 100, version: 2 },
        });
        if (reader.peekMessages("secret-chat") !== undefined) throw new Error("expected cold cache");

        let readStarted!: () => void;
        const readReady = new Promise<void>(resolve => { readStarted = resolve; });

        // Defer tx.done ("complete" event) on the readonly messages read so forgetIdentity()
        // commits while reader.messages() is still in flight.
        const origTx = IDBDatabase.prototype.transaction;
        const origAddListener = EventTarget.prototype.addEventListener;
        let deferredComplete: (() => void) | undefined;
        let readTx: IDBTransaction | undefined;
        IDBDatabase.prototype.transaction = function (storeNames, mode, ...rest) {
          const tx = origTx.call(this, storeNames, mode, ...rest);
          if (!readTx && Array.isArray(storeNames) && storeNames.includes("messages") && (!mode || mode === "readonly")) {
            readTx = tx;
          }
          return tx;
        };
        EventTarget.prototype.addEventListener = function (type, listener, options) {
          if (this === readTx && type === "complete" && typeof listener === "function") {
            return origAddListener.call(this, type, (ev) => {
              deferredComplete = () => listener.call(this, ev);
              readStarted();
            }, options);
          }
          return origAddListener.call(this, type, listener, options);
        };
        try {
          const inFlight = reader.messages("secret-chat");
          await readReady;
          // The readonly IDB tx has already completed with old-identity data,
          // while reader.messages() has not yet resumed past `await Promise.all([..., tx.done])`.
          await reader.forgetIdentity();
          deferredComplete!();
          await inFlight;
        } finally {
          IDBDatabase.prototype.transaction = origTx;
          EventTarget.prototype.addEventListener = origAddListener;
        }

        const peeked = reader.peekMessages("secret-chat");
        const afterWipe = await reader.messages("secret-chat");
        return {
          peekedCount: peeked?.length ?? 0,
          peekedDefined: peeked !== undefined,
          afterWipeCount: afterWipe.length,
        };
      } finally {
        reader.close();
      }
    } finally {
      cache.close();
      indexedDB.deleteDatabase(dbName);
    }
  });
  expect(result).toEqual({ peekedCount: 0, peekedDefined: false, afterWipeCount: 0 });
});

test("beginReset() and finishReset() invalidate messageCache across calling, sibling, and cross-tab caches", async ({ page, context }) => {
  const tab2 = await context.newPage();
  const dbName = `reset-cache-${crypto.randomUUID()}`;
  try {
    await tab2.goto(url);
    await tab2.waitForFunction(() => "ClientCache" in window);

    const setupAndBegin = await page.evaluate(async (name) => {
      const Constructor = (window as unknown as { ClientCache: typeof ClientCache }).ClientCache;
      const c1 = new Constructor(name);
      const c2 = new Constructor(name);
      Object.assign(window, { __resetC1: c1, __resetC2: c2 });
      await c1.saveIdentity({ deviceId: "d1", hubPublicKey: "h1", publicKey: "p1", name: "test", routes: [] });
      await c1.apply({
        v: 1, type: "event", conversationId: "chat-reset", seq: 1, kind: "message.created", at: 100,
        payload: { id: "m1", conversationId: "chat-reset", authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "wipe me" }], status: "complete", createdAt: 100, version: 1 },
      });
      await c1.messages("chat-reset");
      await c2.messages("chat-reset");
      return { c1Warm: c1.peekMessages("chat-reset")?.length, c2Warm: c2.peekMessages("chat-reset")?.length };
    }, dbName);
    expect(setupAndBegin).toEqual({ c1Warm: 1, c2Warm: 1 });

    // Warm cross-tab cache in tab2 as well.
    const tab2Warm = await tab2.evaluate(async (name) => {
      const Constructor = (window as unknown as { ClientCache: typeof ClientCache }).ClientCache;
      const c3 = new Constructor(name);
      Object.assign(window, { __resetC3: c3 });
      await c3.messages("chat-reset");
      return c3.peekMessages("chat-reset")?.length;
    }, dbName);
    expect(tab2Warm).toBe(1);

    // beginReset() must invalidate calling cache, sibling cache, and cross-tab cache.
    const afterBegin = await page.evaluate(async () => {
      const { __resetC1: c1, __resetC2: c2 } = window as unknown as { __resetC1: ClientCache; __resetC2: ClientCache };
      await c1.beginReset();
      return {
        c1Peek: c1.peekMessages("chat-reset"),
        c2Peek: c2.peekMessages("chat-reset"),
      };
    });
    expect(afterBegin).toEqual({ c1Peek: undefined, c2Peek: undefined });
    await expect.poll(() => tab2.evaluate(() => (window as unknown as { __resetC3: ClientCache }).__resetC3.peekMessages("chat-reset"))).toBeUndefined();

    // Even if caches are re-warmed before finishReset(), finishReset() must wipe IDB and invalidate every cache.
    await page.evaluate(async () => {
      const { __resetC1: c1, __resetC2: c2 } = window as unknown as { __resetC1: ClientCache; __resetC2: ClientCache };
      await c1.messages("chat-reset");
      await c2.messages("chat-reset");
    });
    await tab2.evaluate(async () => {
      await (window as unknown as { __resetC3: ClientCache }).__resetC3.messages("chat-reset");
    });

    const afterFinish = await page.evaluate(async (name) => {
      const Constructor = (window as unknown as { ClientCache: typeof ClientCache }).ClientCache;
      const { __resetC1: c1, __resetC2: c2 } = window as unknown as { __resetC1: ClientCache; __resetC2: ClientCache };
      // finishReset() runs on a fresh instance matching the new cacheGeneration (as HostRegistry / reload does).
      const finisher = new Constructor(name);
      try {
        await finisher.finishReset();
        return {
          finisherPeek: finisher.peekMessages("chat-reset"),
          c1Peek: c1.peekMessages("chat-reset"),
          c2Peek: c2.peekMessages("chat-reset"),
          c1Read: (await c1.messages("chat-reset")).length,
          c2Read: (await c2.messages("chat-reset")).length,
        };
      } finally {
        finisher.close();
        c1.close();
        c2.close();
      }
    }, dbName);
    expect(afterFinish).toEqual({ finisherPeek: undefined, c1Peek: undefined, c2Peek: undefined, c1Read: 0, c2Read: 0 });

    await expect.poll(() => tab2.evaluate(() => (window as unknown as { __resetC3: ClientCache }).__resetC3.peekMessages("chat-reset"))).toBeUndefined();
    const tab2AfterFinish = await tab2.evaluate(async () => {
      const c3 = (window as unknown as { __resetC3: ClientCache }).__resetC3;
      try {
        return (await c3.messages("chat-reset")).length;
      } finally {
        c3.close();
      }
    });
    expect(tab2AfterFinish).toBe(0);
  } finally {
    await tab2.close();
    await page.evaluate((name) => { indexedDB.deleteDatabase(name); }, dbName);
  }
});

test("cross-tab early returns in apply() and acceptSnapshot() invalidate stale messageCache without BroadcastChannel", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const Constructor = (window as unknown as { ClientCache: typeof ClientCache }).ClientCache;
    const dbName = `cross-tab-stale-${crypto.randomUUID()}`;
    const savedBC = globalThis.BroadcastChannel;
    // Simulate a multi-tab race where BroadcastChannel is unavailable or has not delivered yet.
    // To isolate two instances from in-process siblingCaches, write tab B's commits directly to IDB
    // (the exact state visible to tab A before BroadcastChannel arrives).
    (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = undefined;
    const tabA = new Constructor(dbName);
    try {
      const m1 = { id: "m1", conversationId: "c-apply", authorType: "bot" as const, authorId: "bot", blocks: [{ type: "text" as const, text: "hello" }], status: "complete" as const, createdAt: 100, version: 1 };
      await tabA.apply({ v: 1, type: "event", conversationId: "c-apply", seq: 1, kind: "message.created", at: 100, payload: m1 });
      // Warm Tab A's messageCache at seq 1.
      const beforeApply = await tabA.messages("c-apply");

      // Simulate Tab B committing seq 2 (deleting m1) directly to IDB without notifying Tab A.
      const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = rawDb.transaction(["messages", "cursors"], "readwrite");
        tx.objectStore("messages").put({ ...m1, status: "deleted", version: 2, activitySeq: 2, activityAt: 200 });
        tx.objectStore("cursors").put(2, "c-apply");
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      } finally {
        rawDb.close();
      }

      // Tab A receives the duplicate WS event seq 2 -> hits early return (event.seq <= last).
      const appliedDuplicate = await tabA.apply({
        v: 1, type: "event", conversationId: "c-apply", seq: 2, kind: "message.updated", at: 200,
        payload: { ...m1, status: "deleted", version: 2 },
      });
      const peekAfterApplyEarlyReturn = tabA.peekMessages("c-apply");
      const messagesAfterApplyEarlyReturn = await tabA.messages("c-apply");

      // Also test missed external event followed by a newer normal apply() commit (seq 3 by Tab B, then seq 4 by Tab A).
      const rawDb2 = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = rawDb2.transaction(["messages", "cursors"], "readwrite");
        tx.objectStore("messages").put({ id: "m-tab-b", conversationId: "c-apply", authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "from B" }], status: "complete", createdAt: 300, version: 1, activitySeq: 3, activityAt: 300 });
        tx.objectStore("cursors").put(3, "c-apply");
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      } finally {
        rawDb2.close();
      }
      await tabA.apply({
        v: 1, type: "event", conversationId: "c-apply", seq: 4, kind: "message.created", at: 400,
        payload: { id: "m-tab-a", conversationId: "c-apply", authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: "from A" }], status: "complete", createdAt: 400, version: 1 },
      });
      const messagesAfterGaplessNext = await tabA.messages("c-apply");

      // Now test acceptSnapshot() early return when another tab already committed the snapshot.
      const s1 = { id: "s1", conversationId: "c-snap", authorType: "bot" as const, authorId: "bot", blocks: [{ type: "text" as const, text: "old" }], status: "complete" as const, createdAt: 100, version: 1 };
      const s2 = { id: "s2", conversationId: "c-snap", authorType: "bot" as const, authorId: "bot", blocks: [{ type: "text" as const, text: "replacement" }], status: "complete" as const, createdAt: 200, version: 1 };
      const conv = { id: "c-snap", type: "direct" as const, title: "Snap", ownerId: "owner", botIds: ["bot"], createdAt: 50, archived: false };
      await tabA.apply({ v: 1, type: "event", conversationId: "c-snap", seq: 1, kind: "message.created", at: 100, payload: s1 });
      await tabA.messages("c-snap"); // warm cache with [s1]

      // Tab A begins receiving snapshot (after: 1 -> seq: 2, lineage: newLineage).
      const newLineage = crypto.randomUUID();
      await tabA.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "snap-1", conversation: conv, after: 1, seq: 2, readSeq: 0, lineage: newLineage });
      await tabA.acceptSnapshot({ v: 1, type: "snapshot.message", id: "snap-1", index: 0, message: s2, contentSeq: 2, unreadSeq: 0 });

      // Before Tab A commits snapshot.end, Tab B commits the same snapshot directly in IDB.
      const rawDb3 = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = rawDb3.transaction(["messages", "cursors", "settings"], "readwrite");
        tx.objectStore("messages").delete("s1");
        tx.objectStore("messages").put({ ...s2, activitySeq: 2, activityAt: 200 });
        tx.objectStore("cursors").put(2, "c-snap");
        tx.objectStore("settings").put(newLineage, "syncLineage:c-snap");
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      } finally {
        rawDb3.close();
      }

      const ended = await tabA.acceptSnapshot({ v: 1, type: "snapshot.end", id: "snap-1", count: 1 });
      const peekAfterSnapEarlyReturn = tabA.peekMessages("c-snap");
      const messagesAfterSnapEarlyReturn = await tabA.messages("c-snap");

      return {
        beforeApplyStatus: beforeApply[0]?.status,
        appliedDuplicate: appliedDuplicate ?? null,
        peekAfterApplyEarlyReturn: peekAfterApplyEarlyReturn ?? null,
        statusAfterApplyEarlyReturn: messagesAfterApplyEarlyReturn.find(m => m.id === "m1")?.status,
        idsAfterGaplessNext: messagesAfterGaplessNext.map(m => m.id),
        ended,
        peekAfterSnapEarlyReturn: peekAfterSnapEarlyReturn ?? null,
        idsAfterSnapEarlyReturn: messagesAfterSnapEarlyReturn.map(m => m.id),
      };
    } finally {
      tabA.close();
      (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = savedBC;
      indexedDB.deleteDatabase(dbName);
    }
  });

  expect(result).toEqual({
    beforeApplyStatus: "complete",
    appliedDuplicate: null,
    peekAfterApplyEarlyReturn: null,
    statusAfterApplyEarlyReturn: "deleted",
    idsAfterGaplessNext: ["m1", "m-tab-b", "m-tab-a"],
    ended: true,
    peekAfterSnapEarlyReturn: null,
    idsAfterSnapEarlyReturn: ["s2"],
  });
});
