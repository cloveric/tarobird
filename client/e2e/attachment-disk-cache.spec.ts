import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { enterMobileChat, openWorkspacePage, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import type * as BufferModule from "../src/download-buffer.js";
import type * as CacheModule from "../src/attachment-disk-cache.js";

type Fixture = typeof BufferModule & typeof CacheModule & { digest(bytes: Uint8Array): string };
declare global { interface Window { bufferFixture: Fixture } }

const MiB = 1024 ** 2;
// 64 hex characters: keys are sha256 digests in production.
const key = (name: string) => name.repeat(64).slice(0, 64);

// Persistent contexts exercise the real origin-private file system and Web Locks.
test("large downloads stay on disk, are read back exactly, and evict least recently used entries not in use", async ({ browser }) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "attachment-disk-cache-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const page = await context.newPage();
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html"); await page.waitForFunction(() => !!window.bufferFixture);
    const result = await page.evaluate(async ([a, b, c, d, small]) => {
      const f = window.bufferFixture, wait = () => new Promise(resolve => setTimeout(resolve, 20));
      const bytes = (fill: number, size = 17 * 1024 ** 2) => new Uint8Array(size).fill(fill);
      const store = (id: string, data: Uint8Array, budget?: number) => f.storeCachedAttachment(id, f.memoryAttachment(new Blob([data], { type: "video/mp4" })), budget);
      const present = async (id: string) => { const source = await f.readCachedAttachment(id); await source?.dispose(); return !!source; };
      // 16 MiB and below belong to the IndexedDB cache; nothing is written here.
      await store(small, bytes(1, 16 * 1024 ** 2));
      const smallCached = await present(small);
      await store(a, bytes(7)); await wait();
      const read = (await f.readCachedAttachment(a))!;
      const exact = { storage: read.storage, type: read.blob.type, digest: f.digest(new Uint8Array(await read.blob.arrayBuffer())) === f.digest(bytes(7)), lock: !!read.browserLock };
      await read.dispose();
      // A, then B; reading A makes B the least recently used.
      await store(b, bytes(8)); await wait(); await present(a); await wait();
      await store(c, bytes(9), 40 * 1024 ** 2);
      const afterEviction = { a: await present(a), b: await present(b), c: await present(c) };
      // An entry being previewed is never evicted: with A held, D cannot make room.
      const held = (await f.readCachedAttachment(a))!;
      await store(d, bytes(10), 20 * 1024 ** 2);
      const whileHeld = { a: await present(a), c: await present(c), d: await present(d), heldStillReadable: (await held.blob.arrayBuffer()).byteLength };
      await held.dispose();
      await f.clearAttachmentDiskCache();
      const cleared = { a: await present(a), c: await present(c) };
      return { smallCached, exact, afterEviction, whileHeld, cleared };
    }, [key("a"), key("b"), key("c"), key("d"), key("e")]);
    expect(result).toEqual({
      smallCached: false,
      exact: { storage: "disk", type: "video/mp4", digest: true, lock: false },
      afterEviction: { a: true, b: false, c: true },
      whileHeld: { a: true, c: false, d: false, heldStillReadable: 17 * MiB },
      cleared: { a: false, c: false },
    });
  } finally { await context.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
});

test("concurrent large downloads share one disk-cache budget", async ({ browser }) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "attachment-cache-budget-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all(pages.map(async page => {
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html");
      await page.waitForFunction(() => !!window.bufferFixture);
    }));
    const budget = 24 * MiB, keys = [key("a"), key("b")];
    await Promise.all(pages.map((page, index) => page.evaluate(async ({ id, budget }) => {
      const f = window.bufferFixture;
      await f.storeCachedAttachment(id, f.memoryAttachment(new Blob([new Uint8Array(17 * 1024 ** 2)])), budget);
    }, { id: keys[index]!, budget })));
    const cached = await pages[0]!.evaluate(async keys => {
      let count = 0, bytes = 0;
      for (const id of keys) {
        const source = await window.bufferFixture.readCachedAttachment(id);
        if (source) { count++; bytes += source.blob.size; await source.dispose(); }
      }
      return { count, bytes };
    }, keys);
    expect(cached.count).toBeGreaterThan(0);
    expect(cached.bytes).toBeLessThanOrEqual(budget);
  } finally { await context.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
});

test("an already cached attachment does not wait for an unrelated disk copy", async ({ browser }) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "attachment-cache-hit-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const page = await context.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html");
    await page.waitForFunction(() => !!window.bufferFixture);
    await page.evaluate(async ({ cached, writing }) => {
      const f = window.bufferFixture, blob = new Blob([new Uint8Array(17 * 1024 ** 2)]);
      await f.storeCachedAttachment(cached, f.memoryAttachment(blob));
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const slow = new Blob([blob]);
      slow.stream = () => new ReadableStream({ async start(controller) { entered(); await gate; controller.enqueue(new Uint8Array(await blob.arrayBuffer())); controller.close(); } });
      const pending = f.storeCachedAttachment(writing, f.memoryAttachment(slow));
      (window as any).budgetProbe = { done: false, release, pending };
      await started;
      // The unrelated writer now holds the budget lock. A duplicate of an
      // already complete entry should release its key without waiting for it.
      void f.storeCachedAttachment(cached, f.memoryAttachment(blob)).then(() => { (window as any).budgetProbe.done = true; });
    }, { cached: key("c"), writing: key("d") });
    await expect.poll(() => page.evaluate(() => (window as any).budgetProbe.done)).toBe(true);
  } finally {
    await page.evaluate(async () => { const probe = (window as any).budgetProbe; if (probe) { probe.release(); await probe.pending; } }).catch(() => undefined);
    await context.close(); await server.close(); await rm(profile, { recursive: true, force: true });
  }
});

test("a video above 16 MiB is downloaded from the Hub once; saving it again reads the disk cache", async ({ browser }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-disk-cache-hub-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(), downloads: string[] = [];
  page.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/attachments/")) downloads.push(request.url()); });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('files','文件助手',?)", [hashSecret("fixture")]);
    const conversation = await hub.store.createConversation("owner", ["files"], "视频缓存", "fixture");
    const bytes = Buffer.alloc(20 * MiB); for (let offset = 0; offset < bytes.length; offset += 4096) bytes.writeUInt32LE(offset, offset);
    const sha256 = createHash("sha256").update(bytes).digest("hex"), name = "clip-20-MiB.mp4";
    const attachmentId = await hub.attachments.importForBot("files", { conversationId: conversation.id, name, size: bytes.length, mime: "video/mp4", sha256 }, bytes);
    await hub.store.publishBotMessage("files", { conversationId: conversation.id, blocks: [{ type: "file", attachmentId, name, size: bytes.length, mime: "video/mp4" }], status: "complete" });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await enterMobileChat(page, conversation.title);
    // Large web saves stream through the service worker, as in downloads.spec.ts.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const save = async () => {
      const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: `另存为 ${name}`, exact: true }).click();
      const file = await downloaded; expect(await file.failure()).toBeNull();
      return createHash("sha256").update(await readFile((await file.path())!)).digest("hex");
    };
    expect(await save()).toBe(sha256);
    const first = downloads.length; expect(first).toBeGreaterThan(0);
    // The background copy finishes before the second save is requested.
    await expect.poll(() => page.evaluate(async () => {
      try { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-attachment-cache-v1"); for await (const _ of root.keys()) return true; } catch { /* not yet */ }
      return false;
    })).toBe(true);
    expect(await save()).toBe(sha256);
    expect(downloads.length).toBe(first);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("deleting attachments removes their disk copies; one in use is never read again and goes when released; one being written never lands", async ({ browser }) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "attachment-disk-cache-forget-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const page = await context.newPage();
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html"); await page.waitForFunction(() => !!window.bufferFixture);
    const result = await page.evaluate(async ([a, b, c, d]) => {
      const f = window.bufferFixture, wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
      const bytes = (fill: number) => new Uint8Array(17 * 1024 ** 2).fill(fill);
      const store = (id: string, data: Uint8Array) => f.storeCachedAttachment(id, f.memoryAttachment(new Blob([data], { type: "video/mp4" })));
      const present = async (id: string) => { const source = await f.readCachedAttachment(id); await source?.dispose(); return !!source; };
      const entries = async () => {
        const names: string[] = [];
        try { for await (const name of (await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-attachment-cache-v1")).keys()) names.push(name); } catch { /* none */ }
        return names.sort();
      };
      await store(a, bytes(1)); await store(b, bytes(2)); await wait();
      const before = await entries();
      await f.forgetCachedAttachments([a, undefined]);
      const idle = { a: await present(a), b: await present(b), entries: await entries() };
      const held = (await f.readCachedAttachment(b))!;
      await f.forgetCachedAttachments([b]);
      const whileHeld = { b: await present(b), heldStillReadable: (await held.blob.arrayBuffer()).byteLength, entries: await entries() };
      await held.dispose();
      for (let n = 0; n < 50 && (await entries()).length; n++) await wait();
      const released = await entries();
      // Deleted while its copy is still being written: by this window (it is
      // asked again under the lock) or by another one (the removal waits).
      let wanted = true;
      const ownCopy = f.storeCachedAttachment(c, f.memoryAttachment(new Blob([bytes(3)], { type: "video/mp4" })), undefined, () => wanted);
      wanted = false; await f.forgetCachedAttachments([c]); await ownCopy;
      const otherWindow = store(d, bytes(4)); await f.forgetCachedAttachments([d]); await otherWindow;
      for (let n = 0; n < 50 && (await entries()).length; n++) await wait();
      return { before, idle, whileHeld, released, writing: { c: await present(c), d: await present(d), entries: await entries() } };
    }, [key("a"), key("b"), key("c"), key("d")]);
    expect(result).toEqual({
      before: [key("a"), key("b")],
      idle: { a: false, b: true, entries: [key("b")] },
      whileHeld: { b: false, heldStillReadable: 17 * MiB, entries: [key("b")] },
      released: [],
      writing: { c: false, d: false, entries: [] },
    });
  } finally { await context.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
});

test("a video the owner deletes in File Center leaves this device's disk cache, so a reload cannot open it", async ({ browser }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-disk-cache-delete-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const cacheEntries = () => page.evaluate(async () => {
    let count = 0;
    try { for await (const _ of (await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-attachment-cache-v1")).keys()) count++; } catch { /* none */ }
    return count;
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('files','文件助手',?)", [hashSecret("fixture")]);
    const conversation = await hub.store.createConversation("owner", ["files"], "视频删除", "fixture");
    const bytes = Buffer.alloc(20 * MiB); for (let offset = 0; offset < bytes.length; offset += 4096) bytes.writeUInt32LE(offset, offset);
    const sha256 = createHash("sha256").update(bytes).digest("hex"), name = "clip-delete.mp4";
    const attachmentId = await hub.attachments.importForBot("files", { conversationId: conversation.id, name, size: bytes.length, mime: "video/mp4", sha256 }, bytes);
    await hub.store.publishBotMessage("files", { conversationId: conversation.id, blocks: [{ type: "file", attachmentId, name, size: bytes.length, mime: "video/mp4" }], status: "complete" });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await enterMobileChat(page, conversation.title);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: `另存为 ${name}`, exact: true }).click();
    expect(await (await downloaded).failure()).toBeNull();
    await expect.poll(cacheEntries).toBe(1);
    await page.goto(hub.url); await waitForClientOnline(page);
    await openWorkspacePage(page, "文件中心");
    const center = page.getByRole("dialog", { name: "文件中心", exact: true });
    await center.getByRole("tab", { name: "附件管理", exact: true }).click();
    await center.getByRole("button", { name: /视频删除/ }).click();
    const details = center.getByRole("complementary", { name: "对话附件", exact: true });
    await details.getByRole("checkbox", { name: `选择附件 ${name}`, exact: true }).check();
    await details.getByRole("button", { name: "删除所选（1）", exact: true }).click();
    await details.getByRole("alertdialog", { name: "确认删除附件", exact: true }).getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(center.locator(".file-center-notices")).toContainText("已删除 1 个附件");
    await expect.poll(cacheEntries).toBe(0);
    // A fresh load has no memory of the deletion: it must ask the Hub (410), not its disk copy.
    await page.goto(hub.url); await waitForClientOnline(page); await enterMobileChat(page, conversation.title);
    const refused = page.waitForResponse(response => new URL(response.url()).pathname.startsWith(`/api/attachments/${attachmentId}`) && response.status() === 410);
    await page.getByRole("button", { name: `另存为 ${name}`, exact: true }).click();
    await refused;
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
