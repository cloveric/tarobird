import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ClientCache, Identity } from "../src/storage.js";

type Fixture = { streamCache: ClientCache; ClientCache: typeof ClientCache };
test("a disk download trims a larger old prefix atomically and keeps its original expiry", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const { streamCache: cache } = window as unknown as Fixture;
      const identity: Identity = { deviceId: "trim-device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] }; await cache.saveIdentity(identity);
      const store = cache.downloadCheckpoints(identity), size = 8 * 1024 ** 2, updatedAt = Date.now() - 1000;
      for (let i = 0; i < 3; i++) {
        if (!await store.append("file", { revision: "same", etag: `"${"a".repeat(64)}"`, total: size * 4, mime: "test", offset: size * (i + 1), updatedAt }, size * i, new Uint8Array(size).fill(i + 1).buffer)) throw new Error("prefix_not_saved");
      }
      const trimmed = await store.load("file", size * 2), first = await store.read("file", "same", 0), second = await store.read("file", "same", 1), removed = await store.read("file", "same", 2);
      const stale = await store.append("file", { ...trimmed!, offset: size * 4 }, size * 3, new ArrayBuffer(size));
      const unchanged = (await store.load("file"))?.offset;
      await store.append("other", { ...trimmed!, revision: "other", offset: size }, 0, new ArrayBuffer(size), size * 2);
      const oldEvicted = !await store.load("file"), otherRetained = (await store.load("other"))?.offset;
      return { offset: trimmed?.offset, expiryKept: trimmed?.updatedAt === updatedAt, first: first && new Uint8Array(first)[0], second: second && new Uint8Array(second)[0], removed: !!removed, stale, unchanged, oldEvicted, otherRetained };
    });
    expect(result).toEqual({ offset: 16 * 1024 ** 2, expiryKept: true, first: 1, second: 2, removed: false, stale: false, unchanged: 16 * 1024 ** 2, oldEvicted: true, otherRetained: 8 * 1024 ** 2 });
  } finally { await page.close(); await server.close(); }
});

test("IndexedDB checkpoints survive reload, isolate hosts and fence old pairings, reset and revocation", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    await page.evaluate(async () => {
      const { streamCache: cache } = window as unknown as Fixture;
      const identity: Identity = { deviceId: "download-device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] };
      await cache.saveIdentity(identity); await cache.saveDraft("chat", "preserve draft");
      await cache.saveAttachment("complete", new Blob(["complete file"]));
      const bytes = new Uint8Array(8 * 1024 ** 2).fill(23);
      const saved = await cache.downloadCheckpoints(identity).append("file", { revision: "first", etag: `"${"a".repeat(64)}"`, total: bytes.length * 3, offset: bytes.length, mime: "application/test", updatedAt: Date.now() }, 0, bytes.buffer);
      if (!saved) throw new Error("checkpoint_not_saved");
    });
    await page.reload(); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const { streamCache: cache, ClientCache: Constructor } = window as unknown as Fixture;
      const identity = (await cache.identity())!, store = cache.downloadCheckpoints(identity), chunk = await store.read("file", "first", 0);
      const restored = { meta: (await store.load("file"))?.offset, length: chunk?.byteLength, first: chunk && new Uint8Array(chunk)[0], last: chunk && new Uint8Array(chunk).at(-1) };
      const other = new Constructor("another-download-host"); await other.saveIdentity({ ...identity, hubPublicKey: "other-hub" });
      const isolated = await other.downloadCheckpoints((await other.identity())!).load("file"); other.close();
      const rejected = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) => e.message);
      const wrongKey = await rejected(cache.downloadCheckpoints({ ...identity, publicKey: "wrong" }).load("file"));
      await cache.markIdentityRevoked(identity);
      const revoked = await rejected(store.read("file", "first", 0));
      const completeAfterRevoke = await (await cache.attachment("complete"))?.text();
      await cache.forgetIdentity(); await cache.saveIdentity({ ...identity, deviceId: "new-device" });
      const stale = await rejected(store.load("file"));
      const fresh = cache.downloadCheckpoints((await cache.identity())!);
      const purged = await fresh.load("file");
      await fresh.append("reset-file", { revision: "reset", etag: `"${"a".repeat(64)}"`, total: 16777216, offset: 8388608, mime: "test", updatedAt: Date.now() }, 0, new ArrayBuffer(8388608));
      await cache.beginReset();
      const resetRead = await rejected(fresh.load("reset-file"));
      const resetWrite = await rejected(fresh.append("late", { revision: "late", etag: `"${"a".repeat(64)}"`, total: 16777216, offset: 8388608, mime: "test", updatedAt: Date.now() }, 0, new ArrayBuffer(8388608)));
      return { restored, isolated, wrongKey, revoked, completeAfterRevoke, stale, purged, resetRead, resetWrite };
    });
    expect(result).toEqual({ restored: { meta: 8388608, length: 8388608, first: 23, last: 23 }, isolated: undefined, wrongKey: "download_pairing_changed", revoked: "download_pairing_changed", completeAfterRevoke: "complete file", stale: "download_pairing_changed", purged: undefined, resetRead: "local_reset_in_progress", resetWrite: "local_reset_in_progress" });
    await page.reload(); await page.waitForFunction(() => "streamCache" in window);
    expect(await page.evaluate(async () => {
      const { streamCache: cache } = window as unknown as Fixture; await cache.finishReset();
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("tarocub-v1"); r.onsuccess = () => resolve(r.result); });
      try { return await Promise.all(["downloadMeta", "downloadChunks"].map((name) => new Promise<number>((resolve) => { const r = db.transaction(name).objectStore(name).count(); r.onsuccess = () => resolve(r.result); }))); } finally { db.close(); }
    })).toEqual([0, 0]);
  } finally { await page.close(); await server.close(); }
});

test("journal writes compare revision and offset, evict old records and expire partial bytes", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const { streamCache: cache } = window as unknown as Fixture;
      const identity: Identity = { deviceId: "device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] }; await cache.saveIdentity(identity);
      const store = cache.downloadCheckpoints(identity), size = 8388608, bytes = new ArrayBuffer(size);
      const meta = (revision: string, offset = size) => ({ revision, etag: `"${"a".repeat(64)}"`, total: size * 100, offset, mime: "test", updatedAt: Date.now() });
      const first = await store.append("race", meta("one"), 0, bytes);
      const staleOffset = await store.append("race", meta("one"), 0, bytes);
      const wrongRevision = await store.append("race", meta("two", size * 2), size, bytes);
      await store.discard("race", "two"); const notDiscarded = (await store.load("race"))?.revision;
      await store.discard("race", "one");
      const late = await store.append("race", meta("one", size * 2), size, bytes);
      for (let i = 0; i < 9; i++) await store.append(`file-${i}`, meta(`revision-${i}`), 0, bytes);
      const evicted = await store.load("file-0"), retained = await store.load("file-8");
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("tarocub-v1"); r.onsuccess = () => resolve(r.result); });
      const count = (name: string) => new Promise<number>((resolve) => { const r = db.transaction(name).objectStore(name).count(); r.onsuccess = () => resolve(r.result); });
      const bounded = await Promise.all([count("downloadMeta"), count("downloadChunks")]);
      // Seed accounting metadata for a 504 MiB journal without allocating it in
      // the test runner. Missing chunk safety is checked by download validation.
      await new Promise<void>((resolve) => { const tx = db.transaction("downloadMeta", "readwrite"); const s = tx.objectStore("downloadMeta"); s.put({ ...retained!, offset: size * 63, scope: JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]) }, "file-8"); tx.oncomplete = () => resolve(); });
      await store.append("file-8", meta("revision-8", size * 64), size * 63, bytes);
      const byteBounded = await count("downloadMeta");
      const excessive = await store.append("file-8", meta("revision-8", size * 65), size * 64, bytes);
      await new Promise<void>((resolve) => { const tx = db.transaction("downloadMeta", "readwrite"); const s = tx.objectStore("downloadMeta"); const r = s.get("file-8"); r.onsuccess = () => s.put({ ...r.result, updatedAt: Date.now() - 86400001 }, "file-8"); tx.oncomplete = () => resolve(); });
      await store.sweep();
      const expired = await store.load("file-8"), afterExpiry = await Promise.all([count("downloadMeta"), count("downloadChunks")]); db.close();
      return { first, staleOffset, wrongRevision, notDiscarded, late, evicted, retained: retained?.offset, bounded, byteBounded, excessive, expired, afterExpiry };
    });
    expect(result).toEqual({ first: true, staleOffset: false, wrongRevision: false, notDiscarded: "one", late: false, evicted: undefined, retained: 8388608, bounded: [8, 8], byteBounded: 1, excessive: false, expired: undefined, afterExpiry: [0, 0] });
  } finally { await page.close(); await server.close(); }
});

test("checkpoint writes leave quota headroom for other host databases and messages", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as Fixture).streamCache, size = 8388608;
      const identity: Identity = { deviceId: "headroom", publicKey: "key", name: "test", routes: [] }; await cache.saveIdentity(identity);
      const store = cache.downloadCheckpoints(identity), meta = { revision: "one", etag: `"${"a".repeat(64)}"`, total: size * 4, offset: size, mime: "test", updatedAt: Date.now() };
      const estimate = navigator.storage.estimate;
      try {
        navigator.storage.estimate = async () => ({ usage: 190 * 1024 ** 2, quota: 400 * 1024 ** 2 });
        const first = await store.append("file", meta, 0, new ArrayBuffer(size));
        navigator.storage.estimate = async () => ({ usage: 198 * 1024 ** 2, quota: 400 * 1024 ** 2 });
        const next = await store.append("file", { ...meta, offset: size * 2 }, size, new ArrayBuffer(size));
        const restored = await store.load("file");
        return { first, next, offset: restored?.offset, timestampUnchanged: restored?.updatedAt === meta.updatedAt };
      } finally { navigator.storage.estimate = estimate; }
    });
    expect(result).toEqual({ first: true, next: false, offset: 8388608, timestampUnchanged: true });
  } finally { await page.close(); await server.close(); }
});

test("version 5 upgrade preserves visible history, drafts and completed attachments", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const name = "tarocub-upgrade-downloads";
      const old = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open(name, 5);
        r.onupgradeneeded = () => {
          for (const store of ["settings", "activity", "attachmentData", "attachmentMeta", "cursors", "syncState"]) r.result.createObjectStore(store);
          r.result.createObjectStore("conversations", { keyPath: "id" }); r.result.createObjectStore("outbox", { keyPath: "id" });
          r.result.createObjectStore("messages", { keyPath: "id" }).createIndex("conversation", "conversationId");
          r.result.createObjectStore("syncMessages", { keyPath: ["owner", "message.id"] }).createIndex("owner", "owner");
        }; r.onsuccess = () => resolve(r.result);
      });
      const identity: Identity = { deviceId: "old", publicKey: "old-key", hubPublicKey: "old-hub", name: "existing device", routes: [] };
      await new Promise<void>((resolve) => {
        const tx = old.transaction(["settings", "messages", "attachmentData", "attachmentMeta"], "readwrite");
        tx.objectStore("settings").put(identity, "identity"); tx.objectStore("settings").put("unfinished draft", "draft:chat");
        tx.objectStore("messages").put({ id: "message", conversationId: "chat", authorId: "bot", authorType: "bot", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "text", text: "existing history" }] });
        tx.objectStore("attachmentData").put({ bytes: new TextEncoder().encode("verified cache").buffer, type: "text/plain" }, "file");
        tx.objectStore("attachmentMeta").put({ size: 14, accessed: Date.now() }, "file"); tx.oncomplete = () => resolve();
      }); old.close();
      const cache = new (window as unknown as Fixture).ClientCache(name);
      try { return { device: (await cache.identity())?.deviceId, draft: await cache.draft("chat"), message: (await cache.messages("chat"))[0]?.id, file: await (await cache.attachment("file"))?.text(), partial: await cache.downloadCheckpoints(identity).load("file") }; }
      finally { cache.close(); }
    });
    expect(result).toEqual({ device: "old", draft: "unfinished draft", message: "message", file: "verified cache", partial: undefined });
  } finally { await page.close(); await server.close(); }
});

test("a failed IndexedDB write cannot advance a checkpoint or leave an uncommitted chunk", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as Fixture).streamCache, size = 8388608;
      const identity: Identity = { deviceId: "quota", publicKey: "key", name: "quota", routes: [] }; await cache.saveIdentity(identity);
      const store = cache.downloadCheckpoints(identity), meta = { revision: "quota", etag: `"${"c".repeat(64)}"`, total: size * 4, offset: size, mime: "test", updatedAt: Date.now() };
      await store.append("file", meta, 0, new ArrayBuffer(size));
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { if (this.name === "downloadMeta") { this.transaction.abort(); throw new DOMException("Disk full", "QuotaExceededError"); } return put.apply(this, args); };
      let error = "";
      try { await store.append("file", { ...meta, offset: size * 2 }, size, new ArrayBuffer(size)); } catch (e) { error = (e as Error).name; }
      finally { IDBObjectStore.prototype.put = put; }
      return { error, offset: (await store.load("file"))?.offset, extra: !!await store.read("file", "quota", 1), original: (await store.read("file", "quota", 0))?.byteLength };
    });
    expect(result).toEqual({ error: "QuotaExceededError", offset: 8388608, extra: false, original: 8388608 });
  } finally { await page.close(); await server.close(); }
});
