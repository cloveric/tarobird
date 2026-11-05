import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots } from "./fixtures/mobile.js";
import { HubServer } from "../../src/hub/server.js";

test("live history clearing batches presentation while committing every tombstone and its final tail", async ({ page }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "clear-refresh-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const arrivals: number[] = [];
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => { if (String(payload).includes('"status":"deleted"')) arrivals.push(Date.now()); }));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','清理助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "实时清理", "clear-refresh");
    let throughId = "";
    for (let i = 0; i < 103; i++) throughId = (await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: `OLD_${i}` }] })).id;
    const kept = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "KEEP_LATEST" }] });
    await page.goto(url);
    await page.evaluate(async () => {
      const { HubConnection } = await import("/src/connection.ts");
      const { ClientCache } = await import("/src/storage.ts");
      const apply = ClientCache.prototype.apply;
      const timing = { applies: [] as number[] }; Object.assign(window, { clearApplyTiming: timing });
      ClientCache.prototype.apply = async function(...args) {
        const started = performance.now();
        const result = await apply.apply(this, args);
        if (result?.status === "deleted") timing.applies.push(performance.now() - started);
        return result;
      };
      const subscribe = HubConnection.prototype.subscribe;
      const receipts = new WeakMap();
      HubConnection.prototype.subscribe = function(listener) {
        const receipt = receipts.get(this) ?? { revisions: 0, measuring: false, lastRevision: this.state.cacheRevision };
        receipts.set(this, receipt);
        Object.assign(window, { clearRefreshFixture: { connection: this, receipt } });
        return subscribe.call(this, () => {
          if (receipt.measuring && receipt.lastRevision !== this.state.cacheRevision) receipt.revisions++;
          receipt.lastRevision = this.state.cacheRevision; listener();
        });
      };
    });
    await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await expect(page.locator(`article[data-message-id="${kept.id}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("progressbar", { name: /^同步历史/ })).toHaveCount(0, { timeout: 30_000 });
    await page.evaluate(() => { (window as any).clearRefreshFixture.receipt.measuring = true; });
    const started = Date.now();
    const first = await hub.store.clearMessages("owner", chat.id, { throughId });
    const last = await hub.store.clearMessages("owner", chat.id, { throughId });
    console.log("Clear Host commit", JSON.stringify({ elapsedMs: Date.now() - started }));
    expect(first.clearedIds).toHaveLength(100); expect(last.clearedIds).toHaveLength(3);
    await expect.poll(() => page.evaluate(async id => {
      const cache = (window as any).clearRefreshFixture.connection.cache;
      return (await cache.messages(id)).filter((message: { status: string }) => message.status === "deleted").length;
    }, chat.id), { timeout: 60_000 }).toBe(103);
    // The final partial batch must become visible without another incoming event.
    await expect(page.locator(`article[data-message-id="${throughId}"]`)).toHaveCount(0);
    await expect(page.locator(`article[data-message-id="${kept.id}"]`)).toBeVisible();
    const receipt = await page.evaluate(() => (window as any).clearRefreshFixture.receipt);
    console.log("Live clear refresh", JSON.stringify({ ...receipt, elapsedMs: Date.now() - started }));
    console.log("Clear delivery timings", JSON.stringify({ arrivals: arrivals.length, arrivalMs: arrivals.at(-1)! - arrivals[0]!, apply: await page.evaluate(() => (window as any).clearApplyTiming) }));
    await info.attach("live-clear-refresh", { body: JSON.stringify(receipt), contentType: "application/json" });
    expect(receipt.measuring).toBe(true); expect(receipt.revisions).toBeGreaterThan(0);
    expect(receipt.revisions).toBeLessThan(52);
    expect(await page.evaluate(async ({ id, seq }) => (await (window as any).clearRefreshFixture.connection.cache.cursor(id)) >= seq, { id: chat.id, seq: last.seq })).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
