import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { settleReadingLayout, readingAnchor, anchorTop } from "./fixtures/reading-position.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });

test.describe("pending feedback during cache changes", () => {
  let vite: Awaited<ReturnType<typeof createServer>>;
  test.beforeEach(async ({ page }) => {
    vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
    await page.goto(new URL("/e2e/fixtures/outbox-view.html", vite.resolvedUrls!.local[0]).href);
    await expect(page.locator(".fixture-workspace:not([hidden]) output")).toContainText('"ready":true');
  });
  test.afterEach(async ({ page }) => { await page.close(); await vite.close(); });

  test("continuous history revisions cannot starve a completed outbox read", async ({ page }) => {
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, cache = f.hosts.a.cache;
      const original = cache.outbox.bind(cache);
      f.slowReads = { completed: 0, pulses: 0 };
      cache.outbox = async () => { const entries = await original(); await new Promise(resolve => setTimeout(resolve, 90)); f.slowReads.completed++; return entries; };
      // Each pulse represents another committed streaming event. Keep pulsing
      // throughout the assertion; a quiet interval must not be needed to render.
      f.pulses = setInterval(() => { f.slowReads.pulses++; f.refresh("a"); }, 15);
      await f.send("stream-send", "PENDING_DURING_STREAM");
    });
    try {
      await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="stream-send"]')).toContainText("PENDING_DURING_STREAM pending", { timeout: 2500 });
      const counts = await page.evaluate(() => (window as any).outboxFixture.slowReads);
      expect(counts.completed).toBeGreaterThan(0); expect(counts.pulses).toBeGreaterThan(2);
    } finally { await page.evaluate(() => clearInterval((window as any).outboxFixture.pulses)); }
  });

  test("a passive shared-cache view keeps a removed item until fresh history reconciles it", async ({ page }) => {
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("remote-ack", "OTHER_WINDOW_ACCEPTED"); f.holdHistory(); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="remote-ack"]')).toContainText("pending");
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, { ClientCache } = await import("/src/storage.ts");
      const second = new ClientCache(f.hosts.a.cache.databaseName);
      try {
        await f.publish("remote-ack", "OTHER_WINDOW_ACCEPTED");
        await second.acknowledge("remote-ack");
        f.refresh("a"); // The passive window receives another Hub update, no ACK.
      } finally { second.close(); }
    });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="remote-ack"]')).toBeVisible();
    // It cannot call a disappearance "sent": another window may have discarded
    // it. Reconcile against fresh history without exposing a resend action.
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="remote-ack"]')).toContainText("syncing");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="remote-ack"]')).toContainText("OTHER_WINDOW_ACCEPTED");
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="remote-ack"]')).toHaveCount(0);
  });
  test("only a successful history read started after disappearance can retire syncing", async ({ page }) => {
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.send("read-order", "READ_ORDER");
      const cache = f.hosts.a.cache, original = cache.messages.bind(cache);
      f.historyReads = [];
      cache.messages = async (id: string) => {
        const values = await original(id);
        let release!: () => void, reject!: (reason: Error) => void;
        const wait = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
        f.historyReads.push({ release, reject }); await wait; return values;
      };
      f.refresh("a");
    });
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="read-order"]');
    await expect(row).toContainText("pending");
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.historyReads.length)).toBe(1);
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.publish("read-order", "READ_ORDER");
      await f.hosts.a.cache.acknowledge("read-order"); f.refresh("a");
    });
    await expect(row).toContainText("syncing");
    await page.evaluate(() => (window as any).outboxFixture.historyReads[0].release());
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.historyReads.length)).toBe(2);
    await expect(row).toContainText("syncing");
    await page.evaluate(() => (window as any).outboxFixture.historyReads[1].reject(new Error("read_failed")));
    await expect(page.locator('.fixture-workspace:not([hidden]) output')).toContainText('"failed":true');
    await expect(row).toContainText("syncing");
    await page.getByRole("button", { name: "retry history" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.historyReads.length)).toBe(3);
    await page.evaluate(() => (window as any).outboxFixture.historyReads[2].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="read-order"]')).toContainText("READ_ORDER");
    await expect(row).toHaveCount(0);
  });

  test("remote discard reconciles without sent/error status and without holding later messages", async ({ page }) => {
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.send("discarded", "DISCARD_ELSEWHERE"); await f.fail("discarded"); await f.send("next", "NEXT_PENDING"); f.holdHistory();
    });
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="discarded"]');
    await expect(row).toContainText("fixture_failure");
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.hosts.a.cache.discardFailed("discarded"); f.refresh("a"); });
    await expect(row).toContainText("syncing"); await expect(row).not.toContainText("fixture_failure");
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="next"]')).toContainText("NEXT_PENDING pending");
    await page.evaluate(() => (window as any).outboxFixture.select("a", "same", false));
    await page.evaluate(() => (window as any).outboxFixture.select("a"));
    await expect(row).toContainText("syncing");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).outboxFixture.hosts.a.cache.messages("same"))).toEqual([]);
  });

  test("a pending observation survives switching away before another window removes it", async ({ page }) => {
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("away", "AWAY_PENDING"); f.holdHistory(); });
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="away"]');
    await expect(row).toContainText("AWAY_PENDING pending");
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await page.evaluate(async () => { const f = (window as any).outboxFixture; f.select("a", "different"); await f.send("other", "OTHER_CHAT_PENDING", "a", "different"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="other"]')).toContainText("OTHER_CHAT_PENDING pending");
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture; await f.publish("away", "AWAY_PENDING");
      await f.hosts.a.cache.acknowledge("away"); f.refresh("a"); f.select("a");
    });
    await expect(row).toContainText("AWAY_PENDING syncing");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="away"]')).toContainText("AWAY_PENDING");
    await expect(row).toHaveCount(0);
  });

  test("returning to a chat retains observed pending feedback before a stalled queue read finishes", async ({ page }) => {
    await page.evaluate(() => (window as any).outboxFixture.send("return-held", "RETURN_PENDING"));
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="return-held"]');
    await expect(row).toContainText("RETURN_PENDING pending");
    await page.evaluate(async () => { const f = (window as any).outboxFixture; f.select("a", "different"); await f.send("different", "DIFFERENT", "a", "different"); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="different"]')).toContainText("DIFFERENT pending");
    await page.evaluate(() => {
      const f = (window as any).outboxFixture, cache = f.hosts.a.cache, original = cache.outbox.bind(cache);
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      f.returnRead = { held: false, finished: false, release: () => { cache.outbox = original; release(); } };
      cache.outbox = async () => { const entries = await original(); f.returnRead.held = true; await barrier; f.returnRead.finished = true; throw new Error("outbox_read_failed"); };
      f.select("a");
    });
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.returnRead.held)).toBe(true);
    await expect(row).toContainText("RETURN_PENDING pending");
    await page.evaluate(() => (window as any).outboxFixture.returnRead.release());
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.returnRead.finished)).toBe(true);
    await expect(row).toContainText("RETURN_PENDING pending");
  });

  test("hidden conversations do not accumulate receipts for unobserved background sends", async ({ page }) => {
    await page.evaluate(() => (window as any).outboxFixture.select("a", "same", false));
    await expect(page.locator('.fixture-workspace:not([hidden]) output')).toContainText('"visible":false');
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      for (let i = 0; i < 12; i++) { await f.send(`background-${i}`, `BACKGROUND_${i}`); await f.accept(`background-${i}`); }
      f.holdHistory(); f.select("a");
    });
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id^="background-"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id^="background-"]')).toHaveCount(12);
  });

  test("retrying an item discarded by another window refreshes its stale failure", async ({ page }) => {
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("gone-retry", "GONE_RETRY"); await f.fail("gone-retry"); });
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="gone-retry"]');
    await expect(row).toContainText("fixture_failure");
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, { ClientCache } = await import("/src/storage.ts");
      const other = new ClientCache(f.hosts.a.cache.databaseName);
      try { await other.discardFailed("gone-retry"); } finally { other.close(); }
      await f.hosts.a.connection.retryFailed("gone-retry");
    });
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).outboxFixture.hosts.a.cache.outbox())).toEqual([]);
  });

  test("a locally queued visible send retains its later hidden ACK before any queue read completes", async ({ page }) => {
    await page.evaluate(() => {
      const f = (window as any).outboxFixture, { cache, connection } = f.hosts.a;
      f.holdHistory();
      const read = cache.outbox.bind(cache);
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      f.restoreQueueRead = () => { cache.outbox = read; release(); };
      cache.outbox = async () => { const entries = await read(); await barrier; return entries; };
      f.queuedVisibleTask = f.send("hide-fast", "HIDE_FAST");
      f.rawQueue = read;
    });
    await expect.poll(() => page.evaluate(async () => (await (window as any).outboxFixture.rawQueue()).length)).toBe(1);
    await page.evaluate(() => (window as any).outboxFixture.select("a", "same", false));
    await expect(page.locator('.fixture-workspace:not([hidden]) output')).toContainText('"visible":false');
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.publish("hide-fast", "HIDE_FAST");
      f.hiddenAckTask = Reflect.get(f.hosts.a.connection, "ack").call(f.hosts.a.connection, "hide-fast", true);
    });
    await expect.poll(() => page.evaluate(async () => (await (window as any).outboxFixture.rawQueue()).length)).toBe(0);
    await page.evaluate(() => (window as any).outboxFixture.select("a"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="hide-fast"]')).toContainText("HIDE_FAST sent");
    await page.evaluate(async () => { const f = (window as any).outboxFixture; f.restoreQueueRead(); f.holds["history-a"].release(); await Promise.all([f.queuedVisibleTask, f.hiddenAckTask]); });
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="hide-fast"]')).toContainText("HIDE_FAST");
  });

  test("an empty shared queue read cannot retire a visible send before its delayed hidden ACK", async ({ page }) => {
    await page.evaluate(() => {
      const f = (window as any).outboxFixture, { cache } = f.hosts.a;
      f.holdHistory(); const read = cache.outbox.bind(cache);
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      f.emptyReads = 0; f.rawQueue = read;
      f.releaseBeforeRead = () => { cache.outbox = read; release(); };
      cache.outbox = async () => { await barrier; const entries = await read(); if (!entries.length) f.emptyReads++; return entries; };
      f.sendBeforeEmpty = f.send("late-local", "LATE_LOCAL");
    });
    await expect.poll(() => page.evaluate(async () => (await (window as any).outboxFixture.rawQueue()).length)).toBe(1);
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, { cache, connection } = f.hosts.a;
      Reflect.set(connection, "inflightEntry", (await f.rawQueue())[0]);
      await f.publish("late-local", "LATE_LOCAL");
      await cache.acknowledge("late-local"); // The other window commits first.
      f.releaseBeforeRead(); await f.sendBeforeEmpty;
    });
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.emptyReads)).toBeGreaterThan(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => (window as any).outboxFixture.select("a", "same", false));
    await expect(page.locator('.fixture-workspace:not([hidden]) output')).toContainText('"visible":false');
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await Reflect.get(f.hosts.a.connection, "ack").call(f.hosts.a.connection, "late-local", true);
      f.select("a");
    });
    await expect(page.locator('.fixture-workspace:not([hidden]) #queued [data-id="late-local"]')).toContainText("LATE_LOCAL sent");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="late-local"]')).toContainText("LATE_LOCAL");
  });

  test("a newly enqueued copy with a newer order supersedes the missing-item bridge", async ({ page }) => {
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.send("reused", "OLD_PENDING"); f.holdHistory(); });
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="reused"]');
    await expect(row).toContainText("OLD_PENDING pending");
    await page.evaluate(async () => { const f = (window as any).outboxFixture; await f.hosts.a.cache.acknowledge("reused"); f.refresh("a"); });
    await expect(row).toContainText("OLD_PENDING syncing");
    await page.evaluate(() => (window as any).outboxFixture.send("reused", "NEW_PENDING"));
    await expect(row).toContainText("NEW_PENDING pending");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(row).toContainText("NEW_PENDING pending");
  });

  test("outbox mutations do not trigger premature history reads before the message event arrives", async ({ page }) => {
    await page.evaluate(() => {
      const f = (window as any).outboxFixture, cache = f.hosts.a.cache, original = cache.messages.bind(cache);
      f.historyReadCount = 0;
      cache.messages = async (id: string) => { f.historyReadCount++; return original(id); };
    });
    await page.evaluate(() => (window as any).outboxFixture.send("decoupled-1", "DECOUPLED_1"));
    const row = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="decoupled-1"]');
    await expect(row).toContainText("DECOUPLED_1 pending");
    expect(await page.evaluate(() => (window as any).outboxFixture.historyReadCount)).toBe(0);

    // ACK before message.created: keeps "sent" feedback without reading history.
    await page.evaluate(() => Reflect.get((window as any).outboxFixture.hosts.a.connection, "ack").call((window as any).outboxFixture.hosts.a.connection, "decoupled-1", true));
    await expect(row).toContainText("DECOUPLED_1 sent");
    expect(await page.evaluate(() => (window as any).outboxFixture.historyReadCount)).toBe(0);

    // Canonical history event arrives: triggers exactly one history read and retires pending row.
    await page.evaluate(() => (window as any).outboxFixture.publish("decoupled-1", "DECOUPLED_1"));
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="decoupled-1"]')).toContainText("DECOUPLED_1");
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).outboxFixture.historyReadCount)).toBe(1);

    // Failure, retry, and discard also leave history unread.
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, c = f.hosts.a.connection;
      await f.send("decoupled-fail", "DECOUPLED_FAIL");
      await Reflect.get(c, "rejectOperation").call(c, { code: "conversation_archived", message: "archived", retryable: false, requestId: "decoupled-fail" });
    });
    const failedRow = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="decoupled-fail"]');
    await expect(failedRow).toContainText("archived");
    await page.evaluate(() => (window as any).outboxFixture.hosts.a.connection.retryFailed("decoupled-fail"));
    await expect(failedRow).toContainText("DECOUPLED_FAIL pending");
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture, c = f.hosts.a.connection;
      await Reflect.get(c, "rejectOperation").call(c, { code: "conversation_archived", message: "archived", retryable: false, requestId: "decoupled-fail" });
      await f.discard("decoupled-fail");
    });
    await expect(failedRow).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).outboxFixture.historyReadCount)).toBe(1);
  });

  test("delete-before-ACK retires cleanly without phantom sent rows across warm and cold caches", async ({ page }) => {
    // Warm cache path: ACK without messageId after canonical deletion retires
    // immediately with zero extra history reads.
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.send("del-warm", "SECRET_DELETED_WARM");
      await f.publish("del-warm", "SECRET_DELETED_WARM");
      await f.publish("del-warm", "SECRET_DELETED_WARM", "a", "same", true);
    });
    const warmRow = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="del-warm"]');
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="del-warm"]')).toHaveCount(0);
    await page.evaluate(() => {
      const f = (window as any).outboxFixture, cache = f.hosts.a.cache, original = cache.messages.bind(cache);
      f.deleteAckReads = 0;
      cache.messages = async (id: string) => { f.deleteAckReads++; return original(id); };
    });
    await page.evaluate(() => Reflect.get((window as any).outboxFixture.hosts.a.connection, "ack").call((window as any).outboxFixture.hosts.a.connection, "del-warm", true));
    await expect(warmRow).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).outboxFixture.deleteAckReads)).toBe(0);
    await page.evaluate(() => { const f = (window as any).outboxFixture; f.select("a", "different"); f.select("a", "same"); });
    await page.getByRole("button", { name: "retry history" }).click();
    await expect(warmRow).toHaveCount(0);

    // Cold cache + held history path (no messageId): tombstone returned by the
    // history read retires the receipt even when historyRevision === receipt.revision.
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.send("del-cold", "SECRET_DELETED_COLD");
      f.holdHistory();
    });
    const coldRow = page.locator('.fixture-workspace:not([hidden]) #queued [data-id="del-cold"]');
    await expect(coldRow).toContainText("SECRET_DELETED_COLD pending");
    await expect.poll(() => page.evaluate(() => (window as any).outboxFixture.holds["history-a"].held)).toBe(true);
    await page.evaluate(async () => {
      const f = (window as any).outboxFixture;
      await f.publish("del-cold", "SECRET_DELETED_COLD");
      await f.publish("del-cold", "SECRET_DELETED_COLD", "a", "same", true);
      Reflect.get(f.hosts.a.cache, "messageCache").invalidate();
      await Reflect.get(f.hosts.a.connection, "ack").call(f.hosts.a.connection, "del-cold", true);
    });
    await expect(coldRow).toContainText("SECRET_DELETED_COLD sent");
    await page.evaluate(() => (window as any).outboxFixture.holds["history-a"].release());
    await expect(coldRow).toHaveCount(0);
    await expect(page.locator('.fixture-workspace:not([hidden]) #history [data-id="del-cold"]')).toHaveCount(0);
    await page.evaluate(() => { const f = (window as any).outboxFixture; f.select("a", "different"); f.select("a", "same"); });
    await page.getByRole("button", { name: "retry history" }).click();
    await expect(coldRow).toHaveCount(0);
  });

});

for (const width of [1360, 390]) test(`long conversation follows new queued rows but preserves reading position (${width}px)`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outbox-tail-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','长对话助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "长对话发送", "tail");
    for (let i = 0; i < 60; i++) await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: `HISTORY_${i} ` + "历史内容。".repeat(45) }] });
    await page.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", socket => {
      const remote = socket.connectToServer();
      socket.onMessage(data => { if (JSON.parse(data.toString()).type !== "message.send") remote.send(data); });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    if (width <= 760) await selectConversation(page, "长对话发送");
    await expect(page.locator(".message-blocks").filter({ hasText: "HISTORY_59" })).toBeInViewport({ timeout: 20000 });
    // Hold history reads at the current snapshot, leaving only queue layout
    // changes able to bring the new rows into view.
    await page.evaluate(async () => {
      const { ClientCache } = await import("/src/storage.ts"); const original = ClientCache.prototype.messages;
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      Object.assign(window, { releaseTailHistory: release });
      ClientCache.prototype.messages = async function(id: string) { const entries = await original.call(this, id); await barrier; return entries; };
    });
    for (let i = 0; i < 4; i++) {
      await page.getByLabel("消息", { exact: true }).fill(`PENDING_TAIL_${i}\n` + "待发送内容。".repeat(20));
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message.user").filter({ hasText: `PENDING_TAIL_${i}` })).toBeInViewport();
      await expect(page.locator(".queued-message")).toHaveCount(0);
    }
    const scroller = page.locator(".message-scroll");
    await scroller.evaluate(node => { node.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true })); node.scrollTop -= 600; });
    await expect(page.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
    await settleReadingLayout(scroller);
    const anchor = await readingAnchor(scroller);
    const measure = () => scroller.evaluate(node => {
      const viewport = node.getBoundingClientRect();
      return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, viewportHeight: viewport.height,
        anchors: [...node.querySelectorAll<HTMLElement>("[data-message-id], .queued-message")].map(row => ({ id: row.dataset.messageId ?? row.textContent?.slice(0, 45), top: row.getBoundingClientRect().top - viewport.top, height: row.getBoundingClientRect().height })).filter(row => row.top + row.height > 0 && row.top < viewport.height) };
    });
    const beforeDetails = await measure(), before = beforeDetails.scrollTop;
    await page.getByLabel("消息", { exact: true }).fill("PRESERVE_READING_POSITION");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "PRESERVE_READING_POSITION" })).toBeAttached();
    try {
      await settleReadingLayout(scroller);
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeCloseTo(before, 0);
      await expect.poll(() => anchorTop(scroller, anchor.id)).toBeCloseTo(anchor.top, 0);
    }
    finally { await info.attach("reading-position", { body: JSON.stringify({ before: beforeDetails, after: await measure() }, null, 2), contentType: "application/json" }); }
    await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "PRESERVE_READING_POSITION" })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`long-outbox-${width}.png`) });
  } finally {
    await page.evaluate(() => (window as any).releaseTailHistory?.()).catch(() => undefined);
    await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const width of [1360, 390]) test(`two actual pages sharing IDB bridge the sender ACK without a passive ACK (${width}px)`, async ({ page, context }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outbox-two-pages-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const peer = await context.newPage(); let releaseSend: (() => void) | undefined, clientMsgId = "", passiveAcks = 0;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','同步助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "两个窗口", "two-pages");
    await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "TWO_PAGES_READY" }] });
    await page.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", socket => {
      const remote = socket.connectToServer(); socket.onMessage(data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "message.send") { clientMsgId = frame.clientMsgId; releaseSend = () => remote.send(data); } else remote.send(data);
      });
    });
    await peer.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", socket => {
      const remote = socket.connectToServer();
      socket.onMessage(data => { if (JSON.parse(data.toString()).type !== "message.send") remote.send(data); });
      remote.onMessage(data => { if (JSON.parse(data.toString()).type === "message.ack") passiveAcks++; socket.send(data); });
    });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await expect(page.locator(".message-blocks")).toContainText("TWO_PAGES_READY");
    await page.getByLabel("消息", { exact: true }).fill("SHARED_WINDOW_SEND");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => !!releaseSend).toBe(true);
    await peer.setViewportSize({ width, height: 844 }); await peer.goto(url);
    await waitForClientOnline(peer);
    if (width <= 760) await selectConversation(peer, "两个窗口");
    const pending = peer.locator(".message.user").filter({ hasText: "SHARED_WINDOW_SEND" });
    await expect(pending).toContainText("发送中…");
    await expect(peer.locator(".queued-message")).toHaveCount(0);
    await peer.evaluate(async () => {
      const { ClientCache } = await import("/src/storage.ts"), original = ClientCache.prototype.messages;
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      Object.assign(window, { sharedHistory: { held: false, release } });
      ClientCache.prototype.messages = async function(id: string) { const values = await original.call(this, id); (window as any).sharedHistory.held = true; await barrier; return values; };
    });
    await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "START_HELD_READ" }] });
    await expect.poll(() => peer.evaluate(() => (window as any).sharedHistory.held)).toBe(true);
    releaseSend!();
    await expect(page.locator(".message.user").filter({ hasText: "SHARED_WINDOW_SEND" })).toBeVisible();
    await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: "SHARED_WINDOW_SEND" })).toHaveCount(0);
    await expect(page.locator(".queued-message").filter({ hasText: "SHARED_WINDOW_SEND" })).toHaveCount(0);
    // Force a real event after the sender has removed the shared durable entry.
    await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "AFTER_SENDER_ACK" }] });
    await expect(pending).toContainText("正在同步发送状态…"); await expect(pending).toBeInViewport();
    await expect(pending.getByRole("button")).toHaveCount(0); expect(passiveAcks).toBe(0);
    await peer.evaluate(() => (window as any).sharedHistory.release());
    await expect(peer.locator(".message.user").filter({ hasText: "SHARED_WINDOW_SEND" })).toHaveCount(1);
    await expect(peer.locator(".message.user").filter({ hasText: "正在同步发送状态…" })).toHaveCount(0);
    await expect(peer.locator(".queued-message")).toHaveCount(0);
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(item => item.clientMsgId === clientMsgId)).toHaveLength(1);
  } finally {
    await peer.evaluate(() => (window as any).sharedHistory?.release()).catch(() => undefined);
    await peer.close(); await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("real Hub: deleted messages do not stick as sent after disconnect-before-ACK reconnect, live delete-before-ACK, or missing tombstone", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outbox-deleted-ack-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  let blockReconnect = false;
  let dropNextAckAndDisconnect = false;
  let holdNextAck = false;
  let releaseHeldAck: (() => void) | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','删除助手','fixture')");
    await hub.store.createConversation("owner", ["bot"], "备用对话", "backup");
    const chat = await hub.store.createConversation("owner", ["bot"], "删除回归", "delete-ack");
    await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "DELETE_ACK_READY" }] });
    await page.route(`${hub.url}/health`, route => blockReconnect ? route.abort() : route.continue());
    await page.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", socket => {
      const remote = socket.connectToServer();
      socket.onMessage(data => remote.send(data));
      remote.onMessage(data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "message.ack" && dropNextAckAndDisconnect) {
          dropNextAckAndDisconnect = false;
          blockReconnect = true;
          socket.close();
          remote.close();
          return;
        }
        if (frame.type === "message.ack" && holdNextAck) {
          holdNextAck = false;
          releaseHeldAck = () => socket.send(data);
          return;
        }
        socket.send(data);
      });
    });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await selectConversation(page, "删除回归");
    await expect(page.locator(".message-blocks").filter({ hasText: "DELETE_ACK_READY" })).toBeVisible();
    const databaseName = await singleHostCacheName(page);
    const outboxIds = () => page.evaluate(async name => {
      const { ClientCache } = await import("/src/storage.ts");
      const c = new ClientCache(name);
      try { return (await c.outbox()).map(entry => entry.id); } finally { c.close(); }
    }, databaseName);

    // 1. Disconnect before ACK -> another device deletes message -> reconnect duplicate ACK.
    dropNextAckAndDisconnect = true;
    await page.getByLabel("消息", { exact: true }).fill("RECONNECT_DELETED_MSG");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
    await expect.poll(async () => (await hub.store.snapshot("owner", chat.id)).messages.some(m => m.blocks.some(b => b.type === "text" && b.text === "RECONNECT_DELETED_MSG"))).toBe(true);
    const reconnectMsg = (await hub.store.snapshot("owner", chat.id)).messages.find(m => m.blocks.some(b => b.type === "text" && b.text === "RECONNECT_DELETED_MSG"))!;
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [reconnectMsg.id] });
    blockReconnect = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    await expect.poll(outboxIds).toEqual([]);
    await expect(page.locator(".queued-message").filter({ hasText: "RECONNECT_DELETED_MSG" })).toHaveCount(0);
    await expect(page.locator(".message.user").filter({ hasText: "RECONNECT_DELETED_MSG" })).toHaveCount(0);
    await selectConversation(page, "备用对话");
    await selectConversation(page, "删除回归");
    await expect(page.locator(".queued-message").filter({ hasText: "RECONNECT_DELETED_MSG" })).toHaveCount(0);

    // A pending outbox bubble also has .message.user while the ACK is held.
    const committedRows = page.locator(".message.user:not(.is-pending-outbox)");

    // 2. Live delete before delayed message.ack.
    holdNextAck = true; releaseHeldAck = undefined;
    await page.getByLabel("消息", { exact: true }).fill("LIVE_DELETED_MSG");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(committedRows.filter({ hasText: "LIVE_DELETED_MSG" })).toBeVisible();
    await expect.poll(() => !!releaseHeldAck).toBe(true);
    const liveMsg = (await hub.store.snapshot("owner", chat.id)).messages.find(m => m.blocks.some(b => b.type === "text" && b.text === "LIVE_DELETED_MSG"))!;
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [liveMsg.id] });
    await expect(committedRows.filter({ hasText: "LIVE_DELETED_MSG" })).toHaveCount(0);
    releaseHeldAck!();
    await expect.poll(outboxIds).toEqual([]);
    await expect(page.locator(".queued-message, .message.user").filter({ hasText: "LIVE_DELETED_MSG" })).toHaveCount(0);
    await selectConversation(page, "备用对话");
    await selectConversation(page, "删除回归");
    await expect(page.locator(".queued-message, .message.user").filter({ hasText: "LIVE_DELETED_MSG" })).toHaveCount(0);

    // 3. Delayed ACK with no local tombstone at all (simulating snapshot omission):
    // bounded fallback reconciliation retires the phantom "已发送" row cleanly.
    holdNextAck = true; releaseHeldAck = undefined;
    await page.getByLabel("消息", { exact: true }).fill("NO_TOMBSTONE_MSG");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(committedRows.filter({ hasText: "NO_TOMBSTONE_MSG" })).toBeVisible();
    await expect.poll(() => !!releaseHeldAck).toBe(true);
    const noTombstoneMsg = (await hub.store.snapshot("owner", chat.id)).messages.find(m => m.blocks.some(b => b.type === "text" && b.text === "NO_TOMBSTONE_MSG"))!;
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [noTombstoneMsg.id] });
    await expect(committedRows.filter({ hasText: "NO_TOMBSTONE_MSG" })).toHaveCount(0);
    await page.evaluate(async ({ name, messageId, conversationId }) => {
      const request = indexedDB.open(name);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const tx = db.transaction("messages", "readwrite");
        tx.objectStore("messages").delete(messageId);
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      } finally { db.close(); }
      const channel = new BroadcastChannel(`tarobot-messages:${name}`);
      channel.postMessage({ v: 1, conversationId });
      channel.close();
    }, { name: databaseName, messageId: noTombstoneMsg.id, conversationId: chat.id });
    await selectConversation(page, "备用对话");
    await selectConversation(page, "删除回归");
    // Online, the still-queued send is a normal pending bubble, not the dashed box.
    await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: "NO_TOMBSTONE_MSG" })).toContainText("发送中…");
    await expect(page.locator(".queued-message").filter({ hasText: "NO_TOMBSTONE_MSG" })).toHaveCount(0);
    releaseHeldAck!();
    await expect.poll(outboxIds).toEqual([]);
    await expect(page.locator(".queued-message, .message.user").filter({ hasText: "NO_TOMBSTONE_MSG" })).toHaveCount(0, { timeout: 6000 });
    await selectConversation(page, "备用对话");
    await selectConversation(page, "删除回归");
    await expect(page.locator(".queued-message, .message.user").filter({ hasText: "NO_TOMBSTONE_MSG" })).toHaveCount(0);
  } finally {
    blockReconnect = false;
    await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
