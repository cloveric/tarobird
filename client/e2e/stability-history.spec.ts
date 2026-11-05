import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ trace: "off", serviceWorkers: "block" });
for (const historySize of [200, 2000, 10000]) test(`phone with ${historySize} cached messages avoids unrelated history allocations`, async ({ page, browserName }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "history-volume-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Volume worker','fixture')");
    const a = await hub.store.createConversation("owner", ["bot"], "History volume", "a");
    const b = await hub.store.createConversation("owner", ["bot"], "Background volume", "b");
    const live = await hub.store.publishBotMessage("bot", { conversationId: a.id, blocks: [{ type: "text", text: "VOLUME_INITIAL" }], status: "streaming" });
    await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await selectConversation(page, a.title);
    await expect(page.locator(".message-blocks").getByText("VOLUME_INITIAL", { exact: true })).toBeVisible();
    const databaseName = await singleHostCacheName(page);
    await page.evaluate(async ({ databaseName, historySize, a, b }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const tx = db.transaction("messages", "readwrite");
        for (let i = 0; i < historySize; i++) tx.objectStore("messages").put({ id: `volume-${i}`, conversationId: a, authorType: "bot", authorId: "bot", blocks: [{ type: "text", text: `HISTORY_${i} ` + "x".repeat(1024) }], status: "complete", createdAt: i, version: 1 });
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      } finally { db.close(); }
      const { ClientCache } = await import("/src/storage.ts");
      const messages = ClientCache.prototype.messages, apply = ClientCache.prototype.apply;
      const receipt = { reads: 0, records: 0, readMs: [] as number[], events: 0 }; Object.assign(window, { volumeReceipt: receipt });
      ClientCache.prototype.messages = async function(id: string) {
        if (id === a) receipt.reads++;
        const start = performance.now(), result = await messages.call(this, id);
        if (id === a) { receipt.records += result.length; receipt.readMs.push(performance.now() - start); }
        return result;
      };
      ClientCache.prototype.apply = async function(...args) { const result = await apply.apply(this, args); if (args[0].conversationId === b) receipt.events++; return result; };
    }, { databaseName, historySize, a: a.id, b: b.id });
    const samples = [];
    for (let round = 0; round < 3; round++) {
      await hub.store.publishBotMessage("bot", { id: live.id, conversationId: a.id, blocks: [{ type: "text", text: `VOLUME_CURRENT_${round}` }], status: "streaming" });
      await expect(page.locator(".message-blocks").getByText(`VOLUME_CURRENT_${round}`, { exact: true })).toBeVisible();
      const before = await page.evaluate(() => ({ ...(window as any).volumeReceipt }));
      for (let i = 1; i <= 5; i++) {
        await hub.store.publishBotMessage("bot", { conversationId: b.id, blocks: [{ type: "text", text: `BACKGROUND_${round}_${i}` }] });
        await expect.poll(() => page.evaluate(() => (window as any).volumeReceipt.events)).toBe(round * 5 + i);
      }
      const start = Date.now(); await page.getByRole("textbox", { name: "消息", exact: true }).fill(`Draft round ${round}`);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const inputAndPaintMs = Date.now() - start;
      const after = await page.evaluate(() => ({ ...(window as any).volumeReceipt }));
      const rows = await page.locator(".message-scroll [data-message-id]").count();
      expect(after.reads - before.reads).toBe(0); expect(after.records - before.records).toBe(0);
      expect(rows).toBeLessThan(100); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(`Draft round ${round}`);
      samples.push({ round, inputAndPaintMs, mountedMessages: rows, unrelatedReads: after.reads - before.reads, unrelatedRecords: after.records - before.records, lastCurrentReadMs: after.readMs.at(-1) });
    }
    let stream: unknown;
    if (historySize === 10000) {
      await page.evaluate(() => {
        const work = { longTasksSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"), running: true, frames: [] as number[], longTasks: [] as number[], previous: performance.now() };
        Object.assign(window, { historyStreamWork: work });
        const frame = (at: number) => { if (!work.running) return; work.frames.push(at - work.previous); work.previous = at; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        if (work.longTasksSupported) {
          const observer = new PerformanceObserver(list => work.longTasks.push(...list.getEntries().map(entry => entry.duration)));
          observer.observe({ type: "longtask" }); Object.assign(work, { stop: () => observer.disconnect() });
        }
      });
      const before = await page.evaluate(() => ({ ...(window as any).volumeReceipt }));
      const typing: number[] = [];
      for (let index = 0; index < 30; index++) {
        await hub.store.publishBotMessage("bot", { id: live.id, conversationId: a.id, blocks: [{ type: "text", text: `STREAM_${index} ` + "word ".repeat(index * 20) }], status: "streaming" });
        if (index % 5 === 0) {
          const start = Date.now(); await page.getByRole("textbox", { name: "消息", exact: true }).fill(`Streaming draft ${index}`); typing.push(Date.now() - start);
        }
        await page.waitForTimeout(150);
      }
      await expect(page.locator(`[data-message-id="${live.id}"] .message-blocks`)).toContainText("STREAM_29");
      const metrics = await page.evaluate(() => {
        const work = (window as any).historyStreamWork; work.running = false; work.stop?.();
        const frames = [...work.frames].sort((a: number, b: number) => a - b);
        return { frameP95: frames.length ? frames[Math.floor(frames.length * .95)] : null, longestTask: work.longTasksSupported ? Math.max(0, ...work.longTasks) : null };
      });
      const after = await page.evaluate(() => ({ ...(window as any).volumeReceipt }));
      stream = { ...metrics, typingMs: typing, reads: after.reads - before.reads, readElapsedMs: after.readMs.slice(before.readMs.length) };
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("Streaming draft 25");
    }
    await hub.store.publishBotMessage("bot", { id: live.id, conversationId: a.id, blocks: [{ type: "text", text: "VOLUME_COMPLETE" }], status: "complete" });
    await expect(page.locator(".message-blocks").getByText("VOLUME_COMPLETE", { exact: true })).toBeVisible();
    const result = { historySize, samples, stream, scope: `Real App with synthetic cached history and real Hub events; desktop ${browserName} at mobile viewport, not a physical phone` };
    console.log("History volume", JSON.stringify(result));
    await info.attach("history-volume", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
