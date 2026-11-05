import { pairFixtureHost } from "./fixtures/pair-registered-host.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, openMobileHome } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
for (const trigger of ["resume", "incoming-event", "database-upgrade"] as const) test(`retired cache stops ${trigger} recovery without route penalties or data deletion`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), "cache-stability-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  let sockets = 0; page.on("websocket", () => sockets++);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Stability','fixture')");
    const conversation = await hub.store.createConversation("owner", ["bot"], "Recovery", "recovery");
    await page.goto(url + "e2e/fixtures/multiple-hosts.html");
    await page.waitForFunction(() => !!(window as any).multipleHosts);
    const paired = await pairFixtureHost(page, hub, "Isolated audit host");
    await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(id => (window as any).multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate(id => (window as any).multipleHosts.connections.get(id).state.status, paired.host.id)).toBe("online");
    const before = sockets;
    await page.evaluate(async ({ id, cid, trigger }) => {
      const f = (window as any).multipleHosts, cache = f.handles.get(id).cache;
      await cache.saveDraft(cid, "Keep this draft");
      await cache.enqueue({ v: 1, type: "message.send", conversationId: cid, clientMsgId: "unsent-fixture", text: "Keep this pending message", attachments: [] });
      if (trigger === "database-upgrade") {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(cache.databaseName, 10);
          request.onsuccess = () => { request.result.close(); resolve(); };
          request.onerror = () => reject(request.error);
        });
      } else cache.close();
      if (trigger !== "incoming-event") f.connections.get(id).resume(true);
    }, { id: paired.host.id, cid: conversation.id, trigger });
    if (trigger === "incoming-event") await hub.store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text: "Triggers closed-cache write" }] });
    await expect.poll(() => page.evaluate(id => (window as any).multipleHosts.connections.get(id).state.error, paired.host.id)).toContain("本地消息缓存已关闭");
    await page.evaluate(id => {
      const connection = (window as any).multipleHosts.connections.get(id);
      connection.resume(); connection.resume(true);
      window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    }, paired.host.id);
    // Longer than the first several retry delays; no probing occurs at all.
    await page.waitForTimeout(2000);
    expect(sockets).toBe(before);
    const evidence = await page.evaluate(async ({ id, cid }) => {
      const f = (window as any).multipleHosts, handle = f.handles.get(id), connection = f.connections.get(id);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(handle.cache.databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const get = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const tx = db.transaction(["settings", "outbox"]);
        const [identity, outbox] = await Promise.all([get(tx.objectStore("settings").get("identity")), get(tx.objectStore("outbox").getAll())]);
        let draft: string | undefined;
        if (db.version === 9) { const reopened = new f.ClientCache(handle.cache.databaseName); try { draft = await reopened.draft(cid); } finally { reopened.close(); } }
        return { closed: connection.isClosed, cacheClosed: handle.cache.isClosed, penalties: Reflect.get(connection, "failedRoutes").size, identity: !!identity, pending: outbox.map((entry: any) => entry.id), draft };
      } finally { db.close(); }
    }, { id: paired.host.id, cid: conversation.id });
    expect(evidence).toMatchObject({ closed: true, cacheClosed: true, penalties: 0, identity: true, pending: ["unsent-fixture"] });
    if (trigger !== "database-upgrade") expect(evidence.draft).toBe("Keep this draft");
    expect(errors).toEqual([]);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`unrelated conversation activity does not reread the visible ${phone ? "phone" : "desktop"} history`, async ({ page }, info) => {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "history-stability-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','History','fixture')");
    const a = await hub.store.createConversation("owner", ["bot"], "Visible history", "a");
    const b = await hub.store.createConversation("owner", ["bot"], "Background history", "b");
    // Keep the visible turn active: a delayed read receipt for a completed
    // answer is a legitimate same-conversation refresh, not unrelated traffic.
    await hub.store.publishBotMessage("bot", { conversationId: a.id, blocks: [{ type: "text", text: "VISIBLE_INITIAL" }], status: "streaming" });
    await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await selectConversation(page, a.title);
    await expect(page.locator(".message-blocks").getByText("VISIBLE_INITIAL", { exact: true })).toBeVisible();
    await page.evaluate(async ({ a, b }) => {
      const { ClientCache } = await import("/src/storage.ts");
      const read = ClientCache.prototype.messages, apply = ClientCache.prototype.apply;
      const receipt = { reads: 0, events: 0 }; Object.assign(window, { stabilityReads: receipt });
      ClientCache.prototype.messages = function(id: string) { if (id === a) receipt.reads++; return read.call(this, id); };
      ClientCache.prototype.apply = async function(...args) { const result = await apply.apply(this, args); if (args[0].conversationId === b) receipt.events++; return result; };
    }, { a: a.id, b: b.id });
    for (let i = 1; i <= 20; i++) {
      await hub.store.publishBotMessage("bot", { conversationId: b.id, blocks: [{ type: "text", text: `BACKGROUND_${i}` }] });
      await expect.poll(() => page.evaluate(() => (window as any).stabilityReads.events)).toBe(i);
    }
    const receipt = await page.evaluate(() => (window as any).stabilityReads);
    await info.attach("unrelated-history-reads", { body: JSON.stringify(receipt), contentType: "application/json" });
    expect(receipt.reads).toBe(0);
    await hub.store.publishBotMessage("bot", { conversationId: a.id, blocks: [{ type: "text", text: "VISIBLE_FINAL" }] });
    await expect(page.locator(".message-blocks").getByText("VISIBLE_FINAL", { exact: true })).toBeVisible();
    if (phone) await openMobileHome(page);
    await selectConversation(page, b.title);
    await expect(page.locator(".message-blocks").getByText("BACKGROUND_20", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
