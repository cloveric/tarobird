import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import type * as BufferModule from "../src/download-buffer.js";
import type { downloadAttachmentSource } from "../src/downloads.js";
import type { exportAttachment } from "../src/attachment-export.js";

type Fixture = typeof BufferModule & { downloadAttachmentSource: typeof downloadAttachmentSource; exportAttachment: typeof exportAttachment; digest(bytes: Uint8Array): string };
declare global { interface Window { bufferFixture: Fixture; source?: BufferModule.AttachmentSource; saveLease?: BufferModule.AttachmentSource } }

test("browser handoff reports a non-cancellable stage before worker negotiation", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html"); await page.waitForFunction(() => !!window.bufferFixture);
    await page.evaluate(() => {
      const states: string[] = []; let release!: () => void;
      Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker), "controller", { configurable: true, get: () => ({ postMessage: (_data: unknown, ports: MessagePort[]) => { release = () => ports[0]!.postMessage({ type: "unsupported" }); } }) });
      const exported = window.bufferFixture.exportAttachment(new Blob(["verified"]), "handoff.txt", { stage: stage => states.push(stage), delivered: delivery => states.push(delivery) });
      Object.assign(window, { handoffFixture: { states, release, exported } });
    });
    expect(await page.evaluate(() => (window as any).handoffFixture.states)).toEqual(["handoff"]);
    const downloading = page.waitForEvent("download"); await page.evaluate(() => (window as any).handoffFixture.release());
    const file = await downloading; expect(await file.failure()).toBeNull();
    expect(await page.evaluate(async () => { await (window as any).handoffFixture.exported; return (window as any).handoffFixture.states; })).toEqual(["handoff", "browser"]);
  } finally { await page.close(); await server.close(); }
});

// WebKit's private contexts reject OPFS. Persistent contexts exercise the real
// disk path in both engines; compatibility fallback has a separate assertion.
test("disk-backed sources survive active preview/save leases, cross-tab read locks and crash cleanup", async ({ browser }) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "download-buffer-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    let page = await context.newPage(); const other = await context.newPage(), url = server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html";
    for (const target of [page, other]) { await target.goto(url); await target.waitForFunction(() => !!window.bufferFixture); }
    const first = await page.evaluate(async () => {
      const { DownloadBuffer, digest } = window.bufferFixture, buffer = new DownloadBuffer(true), data = new Uint8Array(17 * 1024 ** 2).fill(29);
      await buffer.append(new Blob([data])); window.source = await buffer.finish("application/test");
      window.saveLease = window.source.retain(); await window.source.dispose();
      return { storage: window.source.storage, size: window.source.blob.size, type: window.source.blob.type, digest: digest(new Uint8Array(await window.saveLease.blob.arrayBuffer())), expected: digest(data) };
    });
    expect(first).toMatchObject({ storage: "disk", size: 17 * 1024 ** 2, type: "application/test" }); expect(first.digest).toBe(first.expected);
    await other.evaluate(() => window.bufferFixture.sweepTemporaryDownloads());
    expect(await page.evaluate(async () => new Uint8Array(await window.saveLease!.blob.slice(-1).arrayBuffer())[0])).toBe(29);
    await page.evaluate(async () => { await window.saveLease!.dispose(); await window.saveLease!.dispose(); });
    const count = () => other.evaluate(async () => { const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-download-tmp-v1"); let count = 0; for await (const _ of directory.keys()) count++; return count; });
    expect(await count()).toBe(0);
    const shared = await page.evaluate(async () => {
      const buffer = new window.bufferFixture.DownloadBuffer(true); await buffer.append(new Blob([new Uint8Array(17 * 1024 ** 2).fill(41)]));
      window.source = await buffer.finish("test"); return window.source.browserLock!;
    });
    await other.evaluate(async name => {
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { acquired = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const lock = navigator.locks.request(name, {mode: "shared"}, async () => { acquired(); await held; });
      Object.assign(window, { readLock: { release, lock } }); await ready;
    }, shared);
    await page.evaluate(() => { Object.assign(window, { disposal: window.source!.dispose() }); });
    await other.evaluate(() => window.bufferFixture.sweepTemporaryDownloads()); expect(await count()).toBe(1);
    expect(await page.evaluate(async () => new Uint8Array(await window.source!.blob.slice(-1).arrayBuffer())[0])).toBe(41);
    await other.evaluate(async () => { (window as any).readLock.release(); await (window as any).readLock.lock; });
    await page.evaluate(() => (window as any).disposal); expect(await count()).toBe(0);
    await page.evaluate(async () => { const buffer = new window.bufferFixture.DownloadBuffer(true); await buffer.append(new Blob([new Uint8Array(17 * 1024 ** 2)])); });
    expect(await count()).toBe(1); await page.close();
    // Closing a renderer does not synchronously release its browser-process
    // Web Locks. Sweep again once that lock is released, without deleting a
    // file still owned by a live tab (asserted above).
    await expect.poll(async () => { await other.evaluate(() => window.bufferFixture.sweepTemporaryDownloads()); return count(); }).toBe(0);
  } finally { await context.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
});

test("disk writes and legacy whole-body recovery keep integrity, errors never fall back after writing, unsupported storage remains compatible", async ({ browser }) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "download-buffer-")), context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const page = await context.newPage(); await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-buffer.html"); await page.waitForFunction(() => !!window.bufferFixture);
    const result = await page.evaluate(async () => {
      const { downloadAttachmentSource, DownloadBuffer, digest } = window.bufferFixture;
      const data = new Uint8Array(24 * 1024 ** 2).fill(79), expected = digest(data); let calls = 0, released = 0;
      const connection = { state: { status: "online" }, isClosed: false, subscribe: () => () => undefined, resume: () => undefined, beginFileTransfer: () => () => { released++; },
        readAttachment: async <T>(_id: string, _headers: Record<string, string>, consume: (response: Response) => Promise<T>) => {
          const attempt = ++calls; let offset = 0;
          return consume(new Response(new ReadableStream({ pull(controller) {
            if (offset >= data.length) { controller.close(); return; }
            if (attempt === 1 && offset >= 20 * 1024 ** 2) { controller.error(new TypeError("network_lost")); return; }
            controller.enqueue(data.slice(offset, offset + 1024 ** 2)); offset += 1024 ** 2;
          } }), { headers: { ETag: `"${expected}"`, "Content-Length": String(data.length) } }));
        } };
      const source = await downloadAttachmentSource(connection, "file");
      const saved = { storage: source.storage, hash: digest(new Uint8Array(await source.blob.arrayBuffer())), expected, calls, released }; await source.dispose();
      const failedDownloads: string[] = [];
      for (const scenario of ["cancel", "digest"] as const) {
        const rangeData = new Uint8Array(30 * 1024 ** 2).fill(3), abort = new AbortController();
        const expectedTag = scenario === "digest" ? "0".repeat(64) : digest(rangeData);
        const ranged = { ...connection, readAttachment: async <T>(_id: string, headers: Record<string, string>, consume: (response: Response) => Promise<T>) => {
          const start = Number(headers.Range!.split("=")[1]!.split("-")[0]), end = Math.min(start + 8 * 1024 ** 2, rangeData.length) - 1;
          return consume(new Response(rangeData.slice(start, end + 1), { status: 206, headers: { ETag: `"${expectedTag}"`, "Content-Range": `bytes ${start}-${end}/${rangeData.length}` } }));
        } };
        try { const invalid = await downloadAttachmentSource(ranged, "file", { signal: abort.signal, progress: value => { if (scenario === "cancel" && value >= 0.8) abort.abort(); } }); await invalid.dispose(); failedDownloads.push("incorrectly_returned"); }
        catch (caught) { failedDownloads.push((caught as Error).message); }
      }
      const buffer = new DownloadBuffer(true); await buffer.append(new Blob([data]));
      const write = FileSystemWritableFileStream.prototype.write; let error = "";
      try { FileSystemWritableFileStream.prototype.write = async () => { throw new DOMException("disk_full", "QuotaExceededError"); }; await buffer.append(new Blob(["suffix"])); }
      catch (caught) { error = (caught as Error).message; }
      finally { FileSystemWritableFileStream.prototype.write = write; await buffer.reset(); }
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-download-tmp-v1"); let remaining = 0; for await (const _ of directory.keys()) remaining++;
      const storagePrototype = Object.getPrototypeOf(navigator.storage), getDirectory = storagePrototype.getDirectory;
      let fallback, retryError = "";
      const used = new DownloadBuffer(true); await used.append(new Blob([data])); await used.reset();
      try {
        storagePrototype.getDirectory = async () => { throw new DOMException("private_storage", "UnknownError"); };
        try { await used.append(new Blob([data])); } catch (caught) { retryError = (caught as Error).message; }
        const compatible = new DownloadBuffer(true); await compatible.append(new Blob([data])); const result = await compatible.finish("test");
        fallback = { storage: result.storage, hash: digest(new Uint8Array(await result.blob.arrayBuffer())) }; await result.dispose();
      } finally { storagePrototype.getDirectory = getDirectory; }
      const locksPrototype = Object.getPrototypeOf(navigator.locks), request = locksPrototype.request;
      let lockFallback;
      try {
        locksPrototype.request = async () => { throw new DOMException("opaque_origin", "SecurityError"); };
        const compatible = new DownloadBuffer(true); await compatible.append(new Blob([data])); const result = await compatible.finish("test"); lockFallback = result.storage; await result.dispose();
      } finally { locksPrototype.request = request; }
      // Disk errors while replaying a valid prefix must not discard the journal
      // or silently request the file again from zero.
      let discarded = 0, fetched = 0, writeCalls = 0, restoreError = "";
      const restoring = { ...connection, downloadCheckpoints: {
        load: async () => ({ revision: "saved", offset: 24 * 1024 ** 2, total: 32 * 1024 ** 2, etag: `"${expected}"`, mime: "test", updatedAt: Date.now() }),
        read: async () => new ArrayBuffer(8 * 1024 ** 2), append: async () => true, discard: async () => { discarded++; },
      }, readAttachment: async <T>(): Promise<T> => { fetched++; throw new Error("must_not_fetch"); } };
      try {
        FileSystemWritableFileStream.prototype.write = async function(value) { if (++writeCalls === 2) throw new DOMException("disk_full", "QuotaExceededError"); return write.call(this, value); };
        const invalid = await downloadAttachmentSource(restoring, "restore"); await invalid.dispose();
      } catch (caught) { restoreError = (caught as Error).message; }
      finally { FileSystemWritableFileStream.prototype.write = write; }
      return { saved, error, remaining, fallback, failedDownloads, retryError, lockFallback, discarded, fetched, restoreError };
    });
    expect(result.saved).toMatchObject({ storage: "disk", calls: 2, released: 1 }); expect(result.saved.hash).toBe(result.saved.expected);
    expect(result.error).toContain("临时文件写入失败"); expect(result.remaining).toBe(0);
    expect(result.failedDownloads[0]).toContain("下载已取消"); expect(result.failedDownloads[1]).toContain("校验失败");
    expect(result.fallback).toEqual({ storage: "memory", hash: result.saved.expected });
    expect(result.retryError).toContain("临时文件写入失败"); expect(result.lockFallback).toBe("memory");
    expect(result.restoreError).toContain("临时文件写入失败"); expect(result.discarded).toBe(0); expect(result.fetched).toBe(0);
  } finally { await context.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
});
