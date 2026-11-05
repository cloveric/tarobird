import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { showDisconnectedBots, selectConversation, openMobileHome } from "./fixtures/mobile.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });
test("streaming updates coalesce slow history reads without dropping the final cached content", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), "message-refresh-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','流式助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["bot"], "消息刷新验收", "refresh");
    for (let i = 0; i < 300; i++) await hub.store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text: `HISTORY_${i} ` + "x".repeat(2048) }], status: "complete" });
    const initial = await hub.store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text: "STREAM_START" }], status: "streaming" });
    await page.goto(url);
    await page.evaluate(async () => {
      const { ClientCache } = await import("/src/storage.ts");
      const apply = ClientCache.prototype.apply, messages = ClientCache.prototype.messages;
      const receipt = { events: 0, applyMs: 0, longestApplyMs: 0, historyReads: 0, historyReadMs: 0, historyRecords: 0 };
      Object.assign(window, { replayReceipt: receipt });
      ClientCache.prototype.apply = async function(...args) {
        const started = performance.now();
        try { return await apply.apply(this, args); }
        finally { const elapsed = performance.now() - started; receipt.events++; receipt.applyMs += elapsed; receipt.longestApplyMs = Math.max(receipt.longestApplyMs, elapsed); }
      };
      ClientCache.prototype.messages = async function(...args) {
        const started = performance.now();
        try { const result = await messages.apply(this, args); receipt.historyRecords += result.length; return result; }
        finally { receipt.historyReads++; receipt.historyReadMs += performance.now() - started; }
      };
    });
    await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    // Pairing replays 301 real events. Allow that setup to finish before the
    // measured slow-read barrier, including under parallel browser-suite load.
    await expect(page.locator(".message-blocks").getByText("STREAM_START", { exact: true })).toBeVisible({ timeout: 20_000 });
    const initialReplay = await page.evaluate(() => (window as any).replayReceipt);
    console.log("Initial history replay", JSON.stringify(initialReplay));
    // A catch-up must not reread the growing history for every stored event.
    expect(initialReplay.historyReads).toBeLessThan(60);
    const databaseName = await singleHostCacheName(page);
    await page.evaluate(async id => {
      // Instrument the actual Workspace's cache method, retaining its real IDB
      // results behind a controlled slow-read barrier. No production hooks.
      const { ClientCache } = await import("/src/storage.ts");
      const original = ClientCache.prototype.messages;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const state = { calls: 0, current: 0, max: 0, valueRecords: 0, holding: true, failReads: false, firstReadAt: 0, releasedAt: 0, trailingReadAt: 0,
        release: () => { state.holding = false; state.releasedAt = performance.now(); release(); } };
      Object.assign(window, { refreshFixture: state });
      ClientCache.prototype.messages = async function(conversationId: string) {
        if (conversationId !== id) return original.call(this, conversationId);
        state.calls++; state.current++; state.max = Math.max(state.max, state.current);
        if (!state.firstReadAt) state.firstReadAt = performance.now();
        if (!state.holding && !state.trailingReadAt) state.trailingReadAt = performance.now();
        try { const values = await original.call(this, conversationId); state.valueRecords += values.length; if (state.holding) await barrier; if (state.failReads) throw new DOMException("fixture read aborted", "AbortError"); return values; }
        finally { state.current--; }
      };
    }, conversation.id);
    for (let i = 1; i <= 12; i++) {
      await hub.store.publishBotMessage("bot", { id: initial.id, conversationId: conversation.id, blocks: [{ type: "text", text: `STREAM_UPDATE_${i}` }], status: "streaming" });
      // Wait for each event to reach real IDB so React can observe every update.
      await expect.poll(() => page.evaluate(async ({ databaseName, id }) => {
        const request = indexedDB.open(databaseName);
        const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try { return await new Promise<number>((resolve, reject) => { const get = db.transaction("messages").objectStore("messages").get(id); get.onsuccess = () => resolve(get.result?.version ?? 0); get.onerror = () => reject(get.error); }); }
        finally { db.close(); }
      }, { databaseName, id: initial.id })).toBe(i + 1);
    }
    const before = await page.evaluate(() => { const f = (window as any).refreshFixture; return { calls: f.calls, maxConcurrent: f.max, valueRecords: f.valueRecords }; });
    console.log("Held history reads", JSON.stringify(before));
    await info.attach("held-history-reads", { body: JSON.stringify(before), contentType: "application/json" });
    expect(before.calls).toBe(1); expect(before.maxConcurrent).toBe(1);
    // Deliberately exceed the normal 5 s visibility budget. A stalled read must
    // not be followed by another equally long idle period after it is released.
    await page.evaluate(async () => {
      const f = (window as any).refreshFixture;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 8_000 - (performance.now() - f.firstReadAt))));
      f.release();
    });
    await expect(page.locator(".message-blocks").getByText("STREAM_UPDATE_12", { exact: true })).toBeVisible();
    const recovery = await page.evaluate(() => {
      const f = (window as any).refreshFixture;
      return { heldMs: f.releasedAt - f.firstReadAt, trailingGapMs: f.trailingReadAt - f.releasedAt };
    });
    console.log("Slow read recovery", JSON.stringify(recovery));
    expect(recovery.heldMs).toBeGreaterThanOrEqual(7_900);
    expect(recovery.trailingGapMs).toBeLessThan(1_800);
    expect(await page.evaluate(() => (window as any).refreshFixture.calls)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as any).refreshFixture.max)).toBe(1);
    await hub.store.publishBotMessage("bot", { id: initial.id, conversationId: conversation.id, blocks: [{ type: "text", text: "STREAM_COMPLETE" }], status: "complete" });
    await expect(page.locator(".message-blocks").getByText("STREAM_COMPLETE", { exact: true })).toBeVisible();
    // A failed refresh keeps readable content and offers a real recovery path.
    await page.evaluate(() => {
      (window as any).refreshFixture.failReads = true;
      // Keep this storage fault present until the actual retry click. A single
      // failed read can recover on an unrelated read-marker revision and remove
      // the button before Playwright dispatches it, missing the manual path.
      const recover = (event: Event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if (button?.textContent?.trim() !== "重试" || !button.closest('[role="alert"]')?.textContent?.includes("消息暂时无法刷新")) return;
        (window as any).refreshFixture.failReads = false;
        document.removeEventListener("click", recover, true);
      };
      document.addEventListener("click", recover, true);
    });
    await hub.store.publishBotMessage("bot", { id: initial.id, conversationId: conversation.id, blocks: [{ type: "text", text: "RECOVERED_COMPLETE" }], status: "complete" });
    const alert = page.getByRole("alert").filter({ hasText: "消息暂时无法刷新" });
    await expect(alert).toBeVisible();
    await expect(page.locator(".message-blocks").getByText("STREAM_COMPLETE", { exact: true })).toBeVisible();
    await alert.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".message-blocks").getByText("RECOVERED_COMPLETE", { exact: true })).toBeVisible();
    await expect(alert).toHaveCount(0); expect(errors).toEqual([]);
  } finally {
    const replay = await page.evaluate(() => (window as any).replayReceipt).catch(() => undefined);
    if (replay) { console.log("History replay receipt", JSON.stringify(replay)); await info.attach("history-replay", { body: JSON.stringify(replay), contentType: "application/json" }); }
    await page.evaluate(() => (window as any).refreshFixture?.release()).catch(() => undefined);
    await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const outcome of ["resolve", "reject"] as const) test(`late history ${outcome} cannot overwrite a returned conversation`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), "message-refresh-navigation-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','切换助手','fixture')");
    const a = await hub.store.createConversation("owner", ["bot"], "对话甲", "a");
    const b = await hub.store.createConversation("owner", ["bot"], "对话乙", "b");
    const message = await hub.store.publishBotMessage("bot", { conversationId: a.id, blocks: [{ type: "text", text: "A_INITIAL" }] });
    await hub.store.publishBotMessage("bot", { conversationId: b.id, blocks: [{ type: "text", text: "B_INITIAL" }] });
    await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    await selectConversation(page, a.title);
    await expect(page.locator(".message-blocks").getByText("A_INITIAL", { exact: true })).toBeVisible();
    await page.evaluate(async ({ id, outcome }) => {
      const { ClientCache } = await import("/src/storage.ts");
      const original = ClientCache.prototype.messages;
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      const state = { held: false, settled: false, calls: 0, current: 0, max: 0, release }; Object.assign(window, { navigationFixture: state });
      ClientCache.prototype.messages = async function(conversationId: string) {
        if (conversationId !== id) return original.call(this, conversationId);
        state.calls++; state.current++; state.max = Math.max(state.max, state.current);
        try {
          const values = await original.call(this, conversationId);
          if (!state.held) {
            state.held = true;
            try { await barrier; if (outcome === "reject") throw new DOMException("late read failed", "AbortError"); }
            finally { state.settled = true; }
          }
          return values;
        } finally {
          state.current--;
        }
      };
    }, { id: a.id, outcome });
    await hub.store.publishBotMessage("bot", { id: message.id, conversationId: a.id, blocks: [{ type: "text", text: "A_STALE" }] });
    await expect.poll(() => page.evaluate(() => (window as any).navigationFixture.held)).toBe(true);
    await selectConversation(page, b.title);
    await expect(page.locator(".message-blocks").getByText("B_INITIAL", { exact: true })).toBeVisible();
    await expect(page.locator(".message-blocks").getByText("A_INITIAL", { exact: true })).toHaveCount(0);
    await hub.store.publishBotMessage("bot", { id: message.id, conversationId: a.id, blocks: [{ type: "text", text: "A_CURRENT" }] });
    await selectConversation(page, a.title);
    // A→B→A while the old A read is held must not allocate another A history.
    // Repeated activation is distinct from repeated revisions in one activation.
    await selectConversation(page, b.title); await selectConversation(page, a.title);
    expect(await page.evaluate(() => (window as any).navigationFixture.calls)).toBe(1);
    await page.evaluate(async () => { (window as any).navigationFixture.release(); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    await expect.poll(() => page.evaluate(() => (window as any).navigationFixture.settled)).toBe(true);
    await expect(page.locator(".message-blocks").getByText("A_CURRENT", { exact: true })).toBeVisible();
    await expect(page.locator(".message-blocks").getByText("A_STALE", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "消息暂时无法刷新" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).navigationFixture.max)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => (window as any).navigationFixture?.release()).catch(() => undefined);
    await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("first-read failure is not an empty chat and the phone inbox pauses hidden history reads", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), "message-refresh-phone-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','手机助手','fixture')");
    const a = await hub.store.createConversation("owner", ["bot"], "对话甲", "a");
    const b = await hub.store.createConversation("owner", ["bot"], "已有历史的群", "b", { type: "group" });
    await hub.store.publishBotMessage("bot", { conversationId: a.id, blocks: [{ type: "text", text: "A_INITIAL" }] });
    const message = await hub.store.publishBotMessage("bot", { conversationId: b.id, blocks: [{ type: "text", text: "GROUP_HISTORY" }] });
    await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    await selectConversation(page, a.title);
    await expect(page.locator(".message-blocks").getByText("A_INITIAL", { exact: true })).toBeVisible();
    await page.evaluate(async id => {
      const { ClientCache } = await import("/src/storage.ts");
      const original = ClientCache.prototype.messages;
      let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
      const state = { mode: "fail", calls: 0, held: false, release }; Object.assign(window, { phoneRefreshFixture: state });
      ClientCache.prototype.messages = async function(conversationId: string) {
        if (conversationId !== id) return original.call(this, conversationId);
        state.calls++;
        const values = await original.call(this, conversationId);
        if (state.mode === "fail") throw new DOMException("fixture first read failure", "AbortError");
        if (state.mode === "hold") { state.held = true; await barrier; }
        return values;
      };
    }, b.id);
    await page.setViewportSize({ width: 390, height: 844 }); await selectConversation(page, b.title);
    const alert = page.getByRole("alert").filter({ hasText: "暂时无法读取消息，请重试。" });
    await expect(alert).toBeVisible();
    await expect(page.locator(".conversation-empty, .direct-empty")).toHaveCount(0);
    await page.evaluate(() => { (window as any).phoneRefreshFixture.mode = "hold"; });
    await alert.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).phoneRefreshFixture.held)).toBe(true);
    await expect(page.locator(".conversation-empty, .direct-empty")).toHaveCount(0);
    await page.evaluate(() => { const state = (window as any).phoneRefreshFixture; state.mode = "ok"; state.release(); });
    await expect(page.locator(".message-blocks").getByText("GROUP_HISTORY", { exact: true })).toBeVisible();
    await expect(alert).toHaveCount(0);
    await openMobileHome(page);
    const calls = await page.evaluate(() => (window as any).phoneRefreshFixture.calls);
    await hub.store.publishBotMessage("bot", { id: message.id, conversationId: b.id, blocks: [{ type: "text", text: "GROUP_BACKGROUND_UPDATE" }] });
    const databaseName = await singleHostCacheName(page);
    await expect.poll(() => page.evaluate(async ({ databaseName, id }) => {
      const request = indexedDB.open(databaseName);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<number>((resolve, reject) => { const get = db.transaction("messages").objectStore("messages").get(id); get.onsuccess = () => resolve(get.result?.version ?? 0); get.onerror = () => reject(get.error); }); }
      finally { db.close(); }
    }, { databaseName, id: message.id })).toBe(2);
    expect(await page.evaluate(() => (window as any).phoneRefreshFixture.calls)).toBe(calls);
    await selectConversation(page, b.title);
    await expect(page.locator(".message-blocks").getByText("GROUP_BACKGROUND_UPDATE", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).phoneRefreshFixture.calls)).toBeGreaterThan(calls);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => (window as any).phoneRefreshFixture?.release()).catch(() => undefined);
    await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("phone streaming and typing keep IndexedDB work bounded without losing drafts or final content", async ({ page }, info) => {
  // Pairing, two streams and real per-key draft writes share this integration
  // budget; each content/interaction assertion retains its normal 5 s deadline.
  test.setTimeout(90_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), "message-refresh-bounded-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','有界助手','fixture')");
    const open = await hub.store.createConversation("owner", ["bot"], "正在阅读", "open");
    const other = await hub.store.createConversation("owner", ["bot"], "后台流式", "other");
    for (let i = 0; i < 8; i++) await hub.store.createConversation("owner", ["bot"], `列表会话 ${i}`, `filler-${i}`);
    for (let i = 0; i < 40; i++) await hub.store.publishBotMessage("bot", { conversationId: open.id, blocks: [{ type: "text", text: `OPEN_HISTORY_${i} ` + "y".repeat(1024) }], status: "complete" });
    const live = await hub.store.publishBotMessage("bot", { conversationId: open.id, blocks: [{ type: "text", text: "OPEN_STREAM_0" }], status: "streaming" });
    const background = await hub.store.publishBotMessage("bot", { conversationId: other.id, blocks: [{ type: "text", text: "OTHER_STREAM_0" }], status: "streaming" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    await selectConversation(page, open.title);
    await expect(page.locator(".message-blocks").getByText("OPEN_STREAM_0", { exact: true })).toBeVisible({ timeout: 20_000 });
    const databaseName = await singleHostCacheName(page);
    const version = (id: string) => page.evaluate(async ({ databaseName, id }) => {
      const request = indexedDB.open(databaseName);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<number>((resolve, reject) => { const get = db.transaction("messages").objectStore("messages").get(id); get.onsuccess = () => resolve(get.result?.version ?? 0); get.onerror = () => reject(get.error); }); }
      finally { db.close(); }
    }, { databaseName, id });
    const savedDraft = () => page.evaluate(async ({ databaseName, id }) => {
      const request = indexedDB.open(databaseName);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<string>((resolve, reject) => { const get = db.transaction("settings").objectStore("settings").get(`draft:${id}`); get.onsuccess = () => resolve(get.result ?? ""); get.onerror = () => reject(get.error); }); }
      finally { db.close(); }
    }, { databaseName, id: open.id });
    await page.evaluate(async () => {
      // Count real cache work behind the running Workspace; no production hooks.
      const { ClientCache } = await import("/src/storage.ts");
      const counts = { conversations: 0, activity: 0, saveDraft: 0, draftPreviews: 0, applies: 0, applyMs: 0, history: {} as Record<string, Array<[number, number]>> };
      Object.assign(window, { boundedWork: counts });
      const apply = ClientCache.prototype.apply;
      ClientCache.prototype.apply = async function(...args) {
        const started = performance.now();
        try { return await apply.apply(this, args); }
        finally { counts.applies++; counts.applyMs += performance.now() - started; }
      };
      const wrap = (name: "conversations" | "activity" | "saveDraft" | "draftPreviews") => {
        const original = ClientCache.prototype[name] as (...args: unknown[]) => Promise<unknown>;
        (ClientCache.prototype as any)[name] = function(...args: unknown[]) { counts[name]++; return original.apply(this, args); };
      };
      wrap("conversations"); wrap("activity"); wrap("saveDraft"); wrap("draftPreviews");
      const messages = ClientCache.prototype.messages;
      ClientCache.prototype.messages = async function(conversationId: string) {
        const started = performance.now();
        try { return await messages.call(this, conversationId); }
        finally { (counts.history[conversationId] ??= []).push([started, performance.now()]); }
      };
    });

    // Another conversation streams: the open chat's history is untouched and the
    // directory refreshes coalesce the text-only burst as well.
    const updates = 20;
    for (let i = 1; i <= updates; i++) await hub.store.publishBotMessage("bot", { id: background.id, conversationId: other.id, blocks: [{ type: "text", text: `OTHER_STREAM_${i}` }], status: "streaming" });
    await expect.poll(() => version(background.id), { timeout: 20_000 }).toBe(updates + 1);
    await page.waitForTimeout(300);
    const directoryWork = await page.evaluate(() => { const c = (window as any).boundedWork; return { conversations: c.conversations, activity: c.activity }; });
    console.log("Background stream directory work", JSON.stringify(directoryWork));
    await info.attach("background-directory-work", { body: JSON.stringify(directoryWork), contentType: "application/json" });
    expect(directoryWork.conversations).toBeLessThan(updates / 2);
    expect(directoryWork.activity).toBeLessThan(updates / 2);
    // Only this chat's own read receipt may refresh it; 20 foreign events must not.
    expect(await page.evaluate(id => ((window as any).boundedWork.history[id] ?? []).length, open.id)).toBeLessThanOrEqual(2);

    // The open conversation streams: every full reread starts at least the
    // minimum gap after the previous one ended, and the final text arrives.
    for (let i = 1; i <= 30; i++) await hub.store.publishBotMessage("bot", { id: live.id, conversationId: open.id, blocks: [{ type: "text", text: `OPEN_STREAM_${i}` }], status: "streaming" });
    await hub.store.publishBotMessage("bot", { id: live.id, conversationId: open.id, blocks: [{ type: "text", text: "OPEN_STREAM_DONE" }], status: "complete" });
    await expect(page.locator(".message-blocks").getByText("OPEN_STREAM_DONE", { exact: true })).toBeVisible();
    const reads: Array<[number, number]> = await page.evaluate(id => (window as any).boundedWork.history[id] ?? [], open.id);
    const gaps = reads.slice(1).map(([start], index) => start - reads[index]![1]);
    console.log("Open stream history reads", reads.length, "minimum gap", Math.min(...gaps));
    await info.attach("open-stream-reads", { body: JSON.stringify({ reads: reads.length, gaps }), contentType: "application/json" });
    expect(reads.length).toBeLessThan(31);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(70);

    // A short append-only stream has no terminal or later event to flush it.
    // Its final partial batch must still become visible and remain durable.
    const tail = await hub.store.publishBotMessage("bot", { conversationId: open.id, blocks: [{ type: "text", text: "APPEND" }], status: "streaming" });
    await expect(page.locator(".message-blocks").getByText("APPEND", { exact: true })).toBeVisible();
    for (let i = 1; i <= 3; i++) await hub.store.publishBotMessage("bot", { id: tail.id, conversationId: open.id, blocks: [{ type: "text", text: "APPEND" + "_TAIL".repeat(i) }], status: "streaming" });
    await expect(page.locator(".message-blocks").getByText("APPEND_TAIL_TAIL_TAIL", { exact: true })).toBeVisible();
    expect(await version(tail.id)).toBe(4);
    const streamWork = await page.evaluate(() => {
      const c = (window as any).boundedWork;
      return { applies: c.applies, applyMs: c.applyMs, conversations: c.conversations, activity: c.activity };
    });
    console.log("Text stream work", JSON.stringify(streamWork));
    await info.attach("text-stream-work", { body: JSON.stringify(streamWork), contentType: "application/json" });

    // Continuous typing (each key an input event) coalesces into few draft
    // writes, and the latest text is the one that becomes durable.
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    const before = await page.evaluate(() => ({ ...(window as any).boundedWork }));
    const typingStarted = Date.now();
    await input.pressSequentially("bounded draft typing check", { delay: 15 });
    const typingMs = Date.now() - typingStarted;
    await expect(page.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
    await expect.poll(savedDraft).toBe("bounded draft typing check");
    const typing = await page.evaluate(() => ({ ...(window as any).boundedWork }));
    const writes = typing.saveDraft - before.saveDraft, previews = typing.draftPreviews - before.draftPreviews;
    console.log("Typing draft work", JSON.stringify({ writes, previews, typingMs }));
    await info.attach("typing-draft-work", { body: JSON.stringify({ writes, previews, typingMs, characters: 26 }), contentType: "application/json" });
    // Throttle invariant: the first change writes at once, then at most one
    // write per 250 ms window plus the trailing latest text; never per keystroke.
    expect(writes).toBeLessThanOrEqual(Math.ceil(typingMs / 250) + 2);
    // Playwright may deliver keys much slower than the requested 15 ms under
    // load. Bound writes by measured elapsed time and actual input count, not
    // an assumed sub-three-second typing duration.
    expect(writes).toBeLessThanOrEqual("bounded draft typing check".length + 1);
    expect(previews).toBeLessThanOrEqual(writes + 2);

    // Sending right after typing, before the quiet period, must not leave the
    // sent text behind as a resurrected draft.
    await input.fill("");
    await input.pressSequentially("立即发送不留草稿", { delay: 5 });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-blocks").getByText("立即发送不留草稿", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    await page.waitForTimeout(600);
    expect(await savedDraft()).toBe("");
    await expect(input).toHaveValue("");
    expect(errors).toEqual([]);
  } finally {
    await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
