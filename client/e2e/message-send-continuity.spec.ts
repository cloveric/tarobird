import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { messageAction } from "./fixtures/message-actions.js";
import { showDisconnectedBots, selectConversation, openMobileHome } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });
for (const scenario of ["queued", "history-first", "hidden", "prior-cache-delete", "forward"]) for (const width of [1360, 390]) test(`a sent message remains visible while its accepted history read is delayed (${scenario}, ${width}px)`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-continuity-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  let releaseSend: (() => void) | undefined, clientMsgId = "";
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','发送助手','fixture')");
    await hub.store.createConversation("owner", ["bot"], "备用对话", "other");
    const chat = await hub.store.createConversation("owner", ["bot"], "发送连续性", "chat");
    const seed = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "READY" }] });
    // Hold only this outgoing application frame. Authentication and heartbeat
    // traffic remain real, so a slow test does not simulate a broken socket.
    await page.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", socket => {
      const remote = socket.connectToServer();
      socket.onMessage(data => {
        const frame = JSON.parse(data.toString());
        if (["message.send", "message.forward"].includes(frame.type) && !clientMsgId) { clientMsgId = frame.clientMsgId; releaseSend = () => remote.send(data); }
        else remote.send(data);
      });
    });
    await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    // Both seed chats may share a creation millisecond. Select the intended
    // history explicitly instead of relying on the default initial selection.
    await selectConversation(page, "发送连续性");
    await expect(page.locator(".message-blocks").getByText("READY", { exact: true })).toBeVisible();
    await page.setViewportSize({ width, height: 844 });
    const text = scenario === "forward" ? "转发消息" : "SENT_MESSAGE_MUST_REMAIN_VISIBLE";
    const send = async () => {
      if (scenario === "forward") {
        await messageAction(page, page.locator(`[data-message-id="${seed.id}"]`), "转发消息");
        const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
        await dialog.getByRole("button", { name: "发送连续性", exact: true }).click();
        await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
      } else {
        await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
        await page.getByRole("button", { name: "发送消息", exact: true }).click();
      }
      await expect(page.locator(".queued-message").filter({ hasText: text })).toBeVisible();
      await expect.poll(() => !!releaseSend).toBe(true);
    };
    if (scenario !== "history-first") await send();
    await page.evaluate(async id => {
      const { ClientCache } = await import("/src/storage.ts");
      const original = ClientCache.prototype.messages;
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      const state = { held: false, hold: true, release: () => { state.hold = false; release(); } };
      Object.assign(window, { sendContinuityFixture: state });
      ClientCache.prototype.messages = async function(conversationId: string) {
        const values = await original.call(this, conversationId);
        if (conversationId === id && state.hold) { state.held = true; await barrier; }
        return values;
      };
    }, chat.id);
    await hub.store.publishBotMessage("bot", { id: seed.id, conversationId: chat.id, blocks: [{ type: "text", text: "TRIGGER_HISTORY_READ" }] });
    await expect.poll(() => page.evaluate(() => (window as any).sendContinuityFixture.held)).toBe(true);
    if (scenario === "history-first") await send();
    if (scenario === "hidden") {
      if (width <= 760) await openMobileHome(page);
      else await selectConversation(page, "备用对话");
    }
    if (scenario === "prior-cache-delete") {
      const name = await singleHostCacheName(page);
      await page.evaluate(async ({ name, clientMsgId }) => {
        const { ClientCache } = await import("/src/storage.ts");
        const secondWindowCache = new ClientCache(name);
        try { await secondWindowCache.acknowledge(clientMsgId); } finally { secondWindowCache.close(); }
      }, { name, clientMsgId });
    }
    releaseSend!();
    const databaseName = await singleHostCacheName(page);
    const cached = () => page.evaluate(async ({ databaseName, clientMsgId }) => {
      const request = indexedDB.open(databaseName);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const tx = db.transaction(["messages", "outbox"]);
        const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const [messages, outbox] = await Promise.all([read(tx.objectStore("messages").getAll()), read(tx.objectStore("outbox").getAll())]);
        return { accepted: messages.some(message => message.clientMsgId === clientMsgId), pending: outbox.some(entry => entry.id === clientMsgId) };
      } finally { db.close(); }
    }, { databaseName, clientMsgId });
    await expect.poll(cached).toEqual({ accepted: true, pending: false });
    // Let an independently refreshed outbox reach the DOM, without releasing
    // the history read. At least one representation must still be present.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (scenario === "hidden") await selectConversation(page, "发送连续性");
    const representation = page.locator(".queued-message, .message.user").filter({ hasText: text });
    await expect(representation).toHaveCount(1);
    await expect(representation).toBeInViewport();
    await expect(representation).toContainText("已发送");
    await page.screenshot({ path: info.outputPath(`accepted-but-history-held-${width}.png`) });
    await page.evaluate(() => (window as any).sendContinuityFixture.release());
    await expect(page.locator(".message.user").filter({ hasText: scenario === "forward" ? "TRIGGER_HISTORY_READ" : text })).toBeVisible();
    await expect(page.locator(".queued-message").filter({ hasText: text })).toHaveCount(0);
    const sent = (await hub.store.snapshot("owner", chat.id)).messages.filter(message => message.clientMsgId === clientMsgId);
    expect(sent).toHaveLength(1);
    await info.attach("send-continuity", { body: JSON.stringify({ width, scenario, acceptedBeforeHistoryReleased: true, durableOutboxRemoved: true, serverCopies: sent.length }), contentType: "application/json" });
  } finally {
    await page.evaluate(() => (window as any).sendContinuityFixture?.release()).catch(() => undefined);
    await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test.describe("outbox presentation with real IndexedDB and controlled history", () => {
  let vite: Awaited<ReturnType<typeof createServer>>;
  test.beforeEach(async ({ page }) => {
    vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
    await page.goto(new URL("/e2e/fixtures/outbox-view.html", vite.resolvedUrls!.local[0]).href);
    await expect(page.locator(".fixture-workspace:not([hidden]) output")).toContainText('"ready":true');
  });
  test.afterEach(async ({ page }) => { await page.close(); await vite.close(); });

  test("history failures retain sent feedback, and a deleted canonical message eventually removes it", async ({ page }) => {
    await page.evaluate(() => (window as any).outboxFixture.holdHistory());
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await page.evaluate(() => (window as any).outboxFixture.send("one", "ACKED_WHILE_HISTORY_HELD"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="one"]')).toContainText("pending");
    await page.evaluate(() => (window as any).outboxFixture.accept("one"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="one"]')).toContainText("sent");
    await page.evaluate(() => { const f = (window as any).outboxFixture; f.failHistory.add("a"); f.holds["history-a"].release(); });
    await expect(page.locator(".fixture-workspace:not([hidden]) output")).toContainText('"failed":true');
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="one"]')).toContainText("sent");
    await page.evaluate(() => (window as any).outboxFixture.publish("one", "deleted", "a", "same", true));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="one"]')).toContainText("sent");
    await page.evaluate(() => (window as any).outboxFixture.failHistory.delete("a"));
    await page.getByRole("button", { name: "retry history" }).click();
    await expect(page.locator(".fixture-workspace:not([hidden]) output")).toContainText('"ready":true');
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="one"], .fixture-workspace:not([hidden]) #history [data-id="one"]')).toHaveCount(0);
  });

  test("discard, same-ID retry and card ACK do not wait for history or resurrect a failed snapshot", async ({ page }) => {
    await page.evaluate(async () => { const f = (window as any).outboxFixture; f.holdHistory(); await f.send("failed", "REMOVE_ME"); await f.fail("failed"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="failed"]')).toContainText("fixture_failure");
    await page.evaluate(() => (window as any).outboxFixture.holdOutbox());
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["outbox-a"].held)).toBe(true);
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, { connection, cache } = f.hosts.a;
      Reflect.set(connection, "inflightEntry", (await cache.outbox()).find((entry: any) => entry.id === "failed"));
      await f.discard("failed");
    });
    expect(await page.evaluate(() => Reflect.get((window as any).outboxFixture.hosts.a.connection, "inflightEntry"))).toBeUndefined();
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="failed"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).outboxFixture.holds["outbox-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="failed"]')).toHaveCount(0);
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("retry", "RETRY_ME"); await f.fail("retry"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="retry"]')).toContainText("fixture_failure");
    await page.evaluate(() => (window as any).outboxFixture.holdOutbox());
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["outbox-a"].held)).toBe(true);
    await page.evaluate(() => (window as any).outboxFixture.hosts.a.connection.retryFailed("retry"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="retry"]')).toContainText("pending");
    await page.evaluate(() => (window as any).outboxFixture.holds["outbox-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="retry"]')).toContainText("pending");
    await page.evaluate(() => (window as any).outboxFixture.card("card"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="card"]')).toBeVisible();
    await page.evaluate(() => (window as any).outboxFixture.accept("card", "a", true));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="card"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="retry"]')).toContainText("pending");
  });

  test("receipts survive hidden/chat/host returns and stay separate for identical IDs on two hosts", async ({ page }) => {
    await page.evaluate(async () => { const f = (window as any).outboxFixture; f.holdHistory(); await f.send("same-id", "HOST_A"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toContainText("HOST_A");
    await page.evaluate(() => (window as any).outboxFixture.select("b"));
    await expect(page.locator(".fixture-workspace:not([hidden]) output")).toContainText('"host":"b"');
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("same-id", "HOST_B", "b"); await f.accept("same-id", "a"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toContainText("HOST_B pending");
    await page.evaluate(() => (window as any).outboxFixture.select("a"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toContainText("HOST_A sent");
    await page.evaluate(() => (window as any).outboxFixture.select("a", "different"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).outboxFixture.select("a"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toContainText("HOST_A sent");
    await page.evaluate(() => (window as any).outboxFixture.select("a", "same", false));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).outboxFixture.select("a"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toContainText("HOST_A sent");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="same-id"]')).toContainText("HOST_A");
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).outboxFixture.select("b"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="same-id"]')).toContainText("HOST_B pending");
  });

  test("an ACK supplies feedback even before the queue read has ever rendered its entry", async ({ page }) => {
    await page.evaluate(() => (window as any).outboxFixture.holdHistory());
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, { cache, connection } = f.hosts.a, original = cache.outbox.bind(cache);
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      f.releaseAllOutbox = () => { cache.outbox = original; release(); };
      cache.outbox = async () => { const values = await original(); await barrier; return values; };
      await cache.enqueue({ v: 1, type: "message.send", clientMsgId: "fast-ack", conversationId: "same", text: "FAST_ACK", attachments: [], recipients: [] });
      f.refresh("a");
      await f.publish("fast-ack", "FAST_ACK");
      // The normal connection ACK path commits and emits before its flush read.
      // Keep that final read pending as well as the hook's read.
      f.ackTask = Reflect.get(connection, "ack").call(connection, "fast-ack", true);
    });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="fast-ack"]')).toContainText("FAST_ACK sent");
    await page.evaluate(async () => { const f = (window as any).outboxFixture; f.releaseAllOutbox(); f.holds["history-a"].release(); await f.ackTask; });
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="fast-ack"]')).toContainText("FAST_ACK");
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="fast-ack"]')).toHaveCount(0);
  });

  test("an aborted outbox removal emits no success receipt and reset still fences late removals", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("abort", "ABORTED_ACK"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="abort"]')).toContainText("pending");
    const result = await page.evaluate(async () => {
      const f = (window as any).outboxFixture, { cache, connection } = f.hosts.a;
      let receipts = 0; const unsubscribe = connection.subscribeOutboxSettlement(() => receipts++);
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function(key) { const request = remove.call(this, key); if (this.name === "outbox") this.transaction.abort(); return request; };
      let aborted = false, fenced = false;
      try { await Reflect.get(connection, "ack").call(connection, "abort", true); } catch { aborted = true; }
      finally { IDBObjectStore.prototype.delete = remove; }
      const retained = (await cache.outbox()).some((entry: any) => entry.id === "abort");
      await cache.beginReset();
      try { await Reflect.get(connection, "ack").call(connection, "abort", true); } catch (error) { fenced = String(error).includes("local_reset_in_progress"); }
      unsubscribe(); return { aborted, fenced, retained, receipts };
    });
    expect(result).toEqual({ aborted: true, fenced: true, retained: true, receipts: 0 });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="abort"]')).toContainText("pending");
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => { const c = (window as any).outboxFixture.hosts.a.connection; Reflect.set(c, "inflightEntry", { id: "temporary" }); c.close(); return Reflect.get(c, "inflightEntry"); })).toBeUndefined();
  });
});

async function faultApp(page: import("@playwright/test").Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "send-fault-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','发送助手','fixture')");
  const chat = await hub.store.createConversation("owner", ["bot"], "发送故障", "fault");
  const seed = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "FAULT_READY" }] });
  return { hub, chat, seed, async open() {
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await expect(page.locator(".message-blocks")).toContainText("FAULT_READY");
  }, async close() { await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test("a delayed retry cannot resurrect a failed item that was explicitly removed", async ({ page }) => {
  const f = await faultApp(page);
  try {
    await f.open(); const databaseName = await singleHostCacheName(page);
    await page.evaluate(async ({ databaseName, conversationId }) => {
      const { ClientCache } = await import("/src/storage.ts");
      const cache = new ClientCache(databaseName);
      await cache.enqueue({ v: 1, type: "message.send", clientMsgId: "removed-retry", conversationId, text: "MUST_NOT_RESURRECT", attachments: [], recipients: [] });
      await cache.fail("removed-retry", "fixture_failure"); cache.close();
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      const state = { held: false, done: false, release }; Object.assign(window, { retryRemovalFixture: state });
      // Delay before the retry's write. Covers both the old read/enqueue path
      // and the atomic retry replacement without changing their outcomes.
      for (const method of ["enqueue", "retryFailed"]) {
        const original = ClientCache.prototype[method]; if (!original) continue;
        ClientCache.prototype[method] = async function(...args: any[]) {
          if (args[0] === "removed-retry" || args[0]?.clientMsgId === "removed-retry") { state.held = true; await barrier; }
          const value = await original.apply(this, args); state.done = true; return value;
        };
      }
    }, { databaseName, conversationId: f.chat.id });
    await f.hub.store.publishBotMessage("bot", { id: f.seed.id, conversationId: f.chat.id, blocks: [{ type: "text", text: "REFRESH_FAILED_QUEUE" }] });
    const row = page.locator(".queued-message").filter({ hasText: "MUST_NOT_RESURRECT" });
    await expect(row).toContainText("发送失败");
    await row.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).retryRemovalFixture.held)).toBe(true);
    await row.getByRole("button", { name: "移除待发送项", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.evaluate(() => (window as any).retryRemovalFixture.release());
    await expect.poll(() => page.evaluate(() => (window as any).retryRemovalFixture.done)).toBe(true);
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(async databaseName => { const { ClientCache } = await import("/src/storage.ts"); const c = new ClientCache(databaseName); try { return (await c.outbox()).some((entry: any) => entry.id === "removed-retry"); } finally { c.close(); } }, databaseName)).toBe(false);
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages.some(message => message.clientMsgId === "removed-retry")).toBe(false);
  } finally { await page.evaluate(() => (window as any).retryRemovalFixture?.release()).catch(() => undefined); await f.close(); }
});

test("a failed event commit cannot let an already queued ACK remove the only pending copy", async ({ page }) => {
  const f = await faultApp(page); let blockReconnect = false, ackDelivered = false;
  try {
    await page.route(`${f.hub.url}/health`, route => blockReconnect ? route.abort() : route.continue());
    await page.routeWebSocket(f.hub.url.replace(/^http/, "ws") + "/ws", socket => {
      const remote = socket.connectToServer();
      let userEventDelivered = false, queuedAck: string | Buffer | undefined;
      // Hub ACK and broadcast are independent. This case specifically needs
      // an ACK queued behind the failed event, not one accepted before it.
      remote.onMessage(data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "message.ack") {
          if (!userEventDelivered) { queuedAck = data; return; }
          ackDelivered = true;
        }
        socket.send(data);
        if (frame.type === "event" && frame.payload?.authorType === "user") {
          userEventDelivered = true;
          if (queuedAck !== undefined) { socket.send(queuedAck); queuedAck = undefined; ackDelivered = true; }
        }
      });
    });
    await f.open(); const databaseName = await singleHostCacheName(page);
    await page.evaluate(() => {
      return import("/src/storage.ts").then(({ ClientCache }) => {
        const original = ClientCache.prototype.apply;
        let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
        const state = { held: false, failed: false, release }; Object.assign(window, { eventFailureFixture: state });
        ClientCache.prototype.apply = async function(event: any, ...args: any[]) {
          if (!state.failed && event.payload?.authorType === "user") {
            state.held = true; await barrier; state.failed = true; throw new DOMException("fixture write aborted", "AbortError");
          }
          return original.call(this, event, ...args);
        };
      });
    });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("COMMIT_MUST_RECOVER");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).eventFailureFixture.held)).toBe(true);
    await expect.poll(() => ackDelivered).toBe(true); blockReconnect = true;
    await page.evaluate(() => (window as any).eventFailureFixture.release());
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
    const cached = () => page.evaluate(async databaseName => {
      const { ClientCache } = await import("/src/storage.ts"); const c = new ClientCache(databaseName);
      try { const entries = await c.outbox(); return entries.some((entry: any) => entry.frame.text === "COMMIT_MUST_RECOVER"); } finally { c.close(); }
    }, databaseName);
    await expect.poll(cached).toBe(true);
    await expect(page.locator(".queued-message").filter({ hasText: "COMMIT_MUST_RECOVER" })).toBeInViewport();
    blockReconnect = false; await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".message.user").filter({ hasText: "COMMIT_MUST_RECOVER" })).toBeVisible();
    await expect.poll(cached).toBe(false);
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages.filter(message => message.authorType === "user")).toHaveLength(1);
  } finally { blockReconnect = false; await page.evaluate(() => (window as any).eventFailureFixture?.release()).catch(() => undefined); await f.close(); }
});
