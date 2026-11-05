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
