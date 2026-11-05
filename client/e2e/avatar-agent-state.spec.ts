import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "../../src/hub/bot-avatar-default.js";
import type { Block } from "../../src/client-protocol/index.js";
import { createServer } from "./fixtures/vite.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { mobileHome, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const question: Block[] = [{ type: "card", title: "需要选择", elements: [{ type: "button", text: "提交", actionId: "askq_submit", value: { cctb_lark: "ask_user_question", action: "form_submit", requestId: "question" } }] }];
// Which eye set is showing on the animated face overlay ("open", "happy" or "pain").
const shownEyes = (wrapper: Locator) => wrapper.locator(".agent-face svg").evaluate(svg => ["open", "happy", "pain"].filter(kind => getComputedStyle(svg.querySelector(`.agent-eyes-${kind}`)!).opacity === "1"));
const motion = (wrapper: Locator) => wrapper.locator(":scope > .profile-avatar").evaluate(node => getComputedStyle(node).animationName);

for (const [width, platform] of [[1360, "web"], [390, "ios"], [412, "android"]] as const) test(`list avatars show work, completion, failure, requests and settings on ${platform}`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatar-agent-state-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const phone = width < 760;
  const context = await browser.newContext({ viewport: { width, height: 844 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const closeAvatarSettings = async () => {
    await closeSettings(page);
    if (phone) await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^消息/ }).click();
  };
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','狐狸','fixture'),('beta','章鱼','fixture'),('gamma','小猫','fixture'),('idle','安静','fixture')");
    for (const [bot, avatar] of [["alpha", "pastel-fox"], ["beta", "mini-octopus"], ["gamma", "pastel-cat"], ["idle", "mini-drop"]]) await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + bot, avatar]);
    const fox = await hub.store.createConversation("owner", ["alpha"], "发布计划", "fox");
    const octopus = await hub.store.createConversation("owner", ["beta"], "每周研究", "octopus");
    const cat = await hub.store.createConversation("owner", ["gamma"], "网站文案", "cat");
    const quiet = await hub.store.createConversation("owner", ["idle"], "安静对话", "quiet");
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await waitForClientOnline(page);
    await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
    // Keep tested replies unread: the initial default chat is not guaranteed
    // to be the quiet fixture and would acknowledge its own incoming replies.
    if (!phone) {
      await page.locator(`.conversation-row[data-conversation-id="${quiet.id}"]`).filter({ visible: true }).click();
      await expect(page.getByRole("heading", { name: "安静对话", exact: true })).toBeVisible();
    }
    // Desktop defaults to Bot rows; the phone home lists conversations.
    const avatar = (bot: string, chat: string): Locator => phone
      ? mobileHome(page).locator(`.mh-row[data-conversation-id="${chat}"] .mh-avatar`)
      : page.locator(`.bot-tree[data-bot-id="${bot}"] .bot-identity > .avatar`);
    await expect(avatar("alpha", fox.id)).toBeVisible();
    await expect(avatar("idle", quiet.id)).not.toHaveAttribute("data-agent-state", /.+/);

    const reply = await hub.store.publishBotMessage("alpha", { conversationId: fox.id, blocks: [{ type: "text", text: "正在整理" }], status: "streaming" });
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "working");
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("agent-sway");
    // Working reads as typing, not as a jump: a bubble with three dots takes turns.
    await expect(avatar("alpha", fox.id).locator(".agent-typing .agent-typing-dot")).toHaveCount(3);
    await expect(avatar("alpha", fox.id).locator(".agent-typing")).toBeVisible();
    // The fox's own eyes are found and redrawn; other rows stay untouched.
    await expect(avatar("alpha", fox.id).locator(".agent-face ellipse.agent-eye")).toHaveCount(2);
    await expect(avatar("idle", quiet.id).locator(".agent-face")).toHaveCount(0);

    // The actual shared setting stops a live avatar without hiding its status.
    await openSettings(page);
    const toggle = page.getByRole("switch", { name: "动态头像", exact: true });
    await expect(toggle).toBeChecked(); await toggle.click();
    await expect(toggle).not.toBeChecked();
    await closeAvatarSettings();
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "working");
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("none");
    await expect(avatar("alpha", fox.id).locator(".agent-face")).toHaveCount(0);
    await expect(avatar("alpha", fox.id).locator(".agent-typing")).toHaveCount(0);
    await openSettings(page); await toggle.click(); await closeAvatarSettings();
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("agent-sway");

    // Rows ignore transitions in their first 1.2 s, so a cold start cannot replay a burst.
    await page.waitForTimeout(1300);
    await hub.store.publishBotMessage("alpha", { id: reply.id, conversationId: fox.id, blocks: [{ type: "text", text: "发布计划整理好了" }], status: "complete" });
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "done");
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-enter", "done");
    await expect(avatar("alpha", fox.id).locator(".agent-badge[data-kind=done]")).toBeVisible();
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("agent-cheer");
    // After it plays, the row rests so reordering cannot restart the one-shot,
    // but the smile stays until the reply is read.
    await expect(avatar("alpha", fox.id)).not.toHaveAttribute("data-agent-enter", /.+/);
    await expect(avatar("alpha", fox.id).locator(".agent-badge[data-kind=done]")).toBeVisible();
    await expect.poll(() => shownEyes(avatar("alpha", fox.id))).toEqual(["happy"]);
    // Then it keeps two small happy hops, offset by stable row identity.
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("agent-bounce");
    expect(await avatar("alpha", fox.id).evaluate(node => getComputedStyle(node).getPropertyValue("--agent-phase").trim())).toMatch(/^-?\d+ms$/);

    await hub.store.publishBotMessage("beta", { conversationId: octopus.id, blocks: [{ type: "text", text: "网络连接超时" }], status: "error" });
    await expect(avatar("beta", octopus.id)).toHaveAttribute("data-agent-state", "failed");
    await expect(avatar("beta", octopus.id).locator(".agent-badge[data-kind=failed]")).toBeVisible();
    await expect.poll(() => shownEyes(avatar("beta", octopus.id))).toEqual(["pain"]);

    await hub.store.publishBotMessage("gamma", { conversationId: cat.id, blocks: question, status: "complete" });
    await expect(avatar("gamma", cat.id)).toHaveAttribute("data-agent-state", "ask");
    await expect.poll(() => motion(avatar("gamma", cat.id))).toBe("agent-tilt");
    await expect(avatar("gamma", cat.id).locator(".agent-badge[data-kind=ask]")).toHaveAttribute("title", "待处理");
    // The overlay adds no second picture element and no extra accessible name.
    await expect(avatar("alpha", fox.id).locator("img")).toHaveCount(1);
    await expect(avatar("gamma", cat.id).locator(".agent-badge")).toHaveAttribute("aria-hidden", "true");

    // Turning off persists across reload; status badges remain, and turning on
    // does not replay old completion/failure gestures.
    await openSettings(page); await toggle.click(); await closeAvatarSettings();
    await expect(avatar("gamma", cat.id).locator(".agent-badge[data-kind=ask]")).toBeVisible();
    await expect.poll(() => motion(avatar("gamma", cat.id))).toBe("none");
    await page.reload(); await waitForClientOnline(page);
    if (phone) await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "done");
    await expect(avatar("alpha", fox.id)).not.toHaveAttribute("data-agent-enter", /.+/);
    await expect(avatar("beta", octopus.id)).toHaveAttribute("data-agent-state", "failed");
    await expect(avatar("alpha", fox.id).locator(".agent-typing")).toHaveCount(0);
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("none");
    await expect.poll(() => motion(avatar("gamma", cat.id))).toBe("none");
    await expect(avatar("gamma", cat.id).locator(".agent-face")).toHaveCount(0);
    await openSettings(page); await expect(toggle).not.toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    const bounds = await toggle.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: test.info().outputPath(`animated-avatars-off-${platform}.png`) });
    await toggle.click(); await closeAvatarSettings();
    await expect.poll(() => motion(avatar("gamma", cat.id))).toBe("agent-tilt");
    await expect(avatar("alpha", fox.id)).not.toHaveAttribute("data-agent-enter", /.+/);
    await expect(avatar("beta", octopus.id)).not.toHaveAttribute("data-agent-enter", /.+/);
    // Restored finished states show their held expressions without replaying
    // the cheer; done goes straight to its resting hops.
    await expect.poll(() => shownEyes(avatar("alpha", fox.id))).toEqual(["happy"]);
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("agent-bounce");
    await expect.poll(() => shownEyes(avatar("beta", octopus.id))).toEqual(["pain"]);

    // Reading the finished reply (from any device) returns the avatar to rest.
    const head = await hub.store.db.get<{ seq: number }>("SELECT MAX(seq) AS seq FROM events WHERE conversation_id=?", [fox.id]);
    await hub.store.markRead("owner", fox.id, head!.seq);
    await expect(avatar("alpha", fox.id)).not.toHaveAttribute("data-agent-state", /.+/);
    await expect(avatar("alpha", fox.id).locator(".agent-badge")).toHaveCount(0);

    // A newer separate question/receipt used to replace the running reply.
    // Resolving and reading it must resume work on desktop and both phones.
    const running = await hub.store.publishBotMessage("alpha", { conversationId: fox.id, blocks: [{ type: "text", text: "继续处理" }], status: "streaming" });
    const ask = await hub.store.publishBotMessage("alpha", { conversationId: fox.id, blocks: question, status: "complete" });
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "ask");
    await hub.store.publishBotMessage("alpha", { id: ask.id, conversationId: fox.id, blocks: [{ type: "card", title: "已提交", elements: [{ type: "markdown", text: "答案已送达当前任务" }] }], status: "complete" });
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "working");
    const receipt = await hub.store.publishBotMessage("alpha", { conversationId: fox.id, blocks: [{ type: "text", text: "文件已经送达，继续整理正文" }], status: "complete" });
    const received = await hub.store.db.get<{ seq: number }>("SELECT MAX(seq) AS seq FROM events WHERE conversation_id=?", [fox.id]);
    await hub.store.markRead("owner", fox.id, received!.seq);
    await expect(avatar("alpha", fox.id)).toHaveAttribute("data-agent-state", "working");
    await page.reload(); await waitForClientOnline(page);
    if (phone) await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect.poll(() => motion(avatar("alpha", fox.id))).toBe("agent-sway");
    await expect(avatar("alpha", fox.id).locator(".agent-typing-dot")).toHaveCount(3);
    const firstTransform = await avatar("alpha", fox.id).locator(":scope > .profile-avatar").evaluate(el => getComputedStyle(el).transform);
    await expect.poll(() => avatar("alpha", fox.id).locator(":scope > .profile-avatar").evaluate(el => getComputedStyle(el).transform)).not.toBe(firstTransform);
    // Finishing the matching run removes its active marker even when another
    // message is newer. The receipt is already read; no stale work survives.
    await hub.store.publishBotMessage("alpha", { id: running.id, conversationId: fox.id, blocks: [{ type: "text", text: "处理结束" }], status: "complete" });
    await expect(avatar("alpha", fox.id)).not.toHaveAttribute("data-agent-state", "working");
    expect(receipt.id).not.toBe(running.id);
  } finally {
    await context.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("most library mascots get animated eyes; the fox and phoenix always do", async ({ page }: { page: Page }) => {
  const vite = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false } }); await vite.listen();
  try {
    await page.goto(vite.resolvedUrls!.local[0]!);
    const result = await page.evaluate(async () => {
      const catalogPath = "/src/bot-avatar-catalog.ts", imagesPath = "/src/bot-avatar-images.ts", facePath = "/src/avatar-face.ts";
      const { BOT_AVATARS } = await import(catalogPath) as typeof import("../src/bot-avatar-catalog.js");
      const { botAvatarImage } = await import(imagesPath) as typeof import("../src/bot-avatar-images.js");
      const { loadAvatarFace } = await import(facePath) as typeof import("../src/avatar-face.js");
      const first = await loadAvatarFace(botAvatarImage(BOT_AVATARS.find(avatar => avatar.id === "pastel-fox")!).url);
      const faces = await Promise.all(BOT_AVATARS.map(async avatar => [avatar.id, !!await loadAvatarFace(botAvatarImage(avatar).url)] as const));
      return { total: faces.length, found: faces.filter(([, found]) => found).length, fox: faces.find(([id]) => id === "pastel-fox")?.[1], phoenix: faces.find(([id]) => id === "pastel-phoenix")?.[1], retained: first ? await fetch(first.plain).then(response => response.ok, () => false) : false };
    });
    expect(result.total).toBe(145);
    expect(result.fox).toBe(true);
    expect(result.phoenix, "the brand phoenix animates like the fox").toBe(true);
    expect(result.retained, "a visible face must survive cache eviction").toBe(true);
    expect(result.found).toBeGreaterThanOrEqual(130);
  } finally { await vite.close(); }
});

test("existing reply metadata backfills once without changing messages or preferences", async ({ page }, info) => {
  const vite = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false } }); await vite.listen();
  try {
    await page.goto(vite.resolvedUrls!.local[0]!);
    const result = await page.evaluate(async () => {
      const modulePath = "/src/storage.ts";
      const { ClientCache, defaultPreferences } = await import(modulePath) as typeof import("../src/storage.js");
      const name = "avatar-metadata-backfill", cache = new ClientCache(name);
      await cache.savePreferences({ ...defaultPreferences, animatedAvatars: false });
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const count = 2000, text = "x".repeat(8192), chats = 20;
      try {
        const tx = db.transaction(["messages", "activity"], "readwrite");
        for (let n = 0; n < count; n++) {
          const id = `m-${n}`, conversationId = `chat-${n % chats}`;
          tx.objectStore("messages").put({ id, conversationId, authorId: "bot", authorType: "bot", status: "complete", blocks: [{ type: "text", text }], createdAt: n + 1, version: 1 });
        }
        for (let n = 0; n < chats; n++) tx.objectStore("activity").put({ preview: "unchanged", at: 2000, unread: { [`m-${1980 + n}`]: 2000 }, lastContentSeq: 2000, attention: {} }, `chat-${n}`);
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); });
        const start = performance.now(), first = await cache.activity(), firstMs = performance.now() - start;
        const secondStart = performance.now(), second = await cache.activity(), secondMs = performance.now() - secondStart;
        const retained = await new Promise<any>((resolve, reject) => { const request = db.transaction("messages").objectStore("messages").get("m-0"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        return { count, chats, bodyBytes: count * text.length, firstMs, secondMs, first, second, retainedBytes: retained.blocks[0].text.length, enabled: (await cache.preferences()).animatedAvatars };
      } finally { db.close(); cache.close(); }
    });
    expect(Object.keys(result.first)).toHaveLength(20);
    for (let n = 0; n < 20; n++) expect(result.first[`chat-${n}`]).toMatchObject({ preview: "unchanged", replies: { bot: { id: `m-${1980 + n}`, status: "complete" } }, unread: { [`m-${1980 + n}`]: 2000 } });
    expect(result.second).toEqual(result.first);
    expect(result.retainedBytes).toBe(8192); expect(result.enabled).toBe(false);
    const { first, second, ...metrics } = result;
    await info.attach("backfill-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
    console.log("avatar-backfill", JSON.stringify(metrics));
  } finally { await vite.close(); }
});


test("running avatar metadata upgrades once using only the streaming index", async ({ page }) => {
  const vite = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false } }); await vite.listen();
  try {
    await page.goto(vite.resolvedUrls!.local[0]!);
    const result = await page.evaluate(async () => {
      const storagePath = "/src/storage.ts", statePath = "/src/agent-state.ts";
      const { ClientCache, defaultPreferences } = await import(storagePath) as typeof import("../src/storage.js");
      const { agentSignal } = await import(statePath) as typeof import("../src/agent-state.js");
      const name = "avatar-working-backfill", cache = new ClientCache(name);
      await cache.savePreferences({ ...defaultPreferences, animatedAvatars: false });
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const reads: string[] = [], getAll = IDBIndex.prototype.getAll, cursor = IDBIndex.prototype.openCursor;
      try {
        const tx = db.transaction(["messages", "activity"], "readwrite");
        for (const chat of ["live", "quiet"]) {
          tx.objectStore("activity").put({ preview: "unchanged", at: 100, unread: {}, lastContentSeq: 100, attention: {}, replies: { bot: { id: chat + "-card", status: "complete", createdAt: 100, at: 100 } } }, chat);
          for (let n = 0; n < 64; n++) tx.objectStore("messages").put({ id: chat + n, conversationId: chat, authorId: "bot", authorType: "bot", status: "complete", blocks: [{ type: "text", text: "x".repeat(64 * 1024) }], createdAt: n + 1, version: 1 });
        }
        const run = { id: "live-run", conversationId: "live", authorId: "bot", authorType: "bot", status: "streaming", blocks: [{ type: "text", text: "running" }], createdAt: 10, activityAt: 80, version: 1 };
        tx.objectStore("messages").put(run);
        tx.objectStore("messages").put({ ...run, id: "forward", conversationId: "quiet", forwardedFrom: { conversationId: "elsewhere", messageId: "original" } });
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); });
        IDBIndex.prototype.getAll = function (...args) { reads.push(this.name + ":getAll:" + String(args[0])); return getAll.apply(this, args); };
        IDBIndex.prototype.openCursor = function (...args) { reads.push(this.name + ":cursor"); return cursor.apply(this, args); };
        const first = await cache.activity(), firstReads = [...reads]; reads.length = 0;
        const second = await cache.activity();
        return { live: agentSignal([first.live]), quiet: agentSignal([first.quiet]), firstReads, secondReads: [...reads], retained: JSON.stringify(first) === JSON.stringify(second), preview: first.live?.preview, animated: (await cache.preferences()).animatedAvatars };
      } finally { IDBIndex.prototype.getAll = getAll; IDBIndex.prototype.openCursor = cursor; db.close(); cache.close(); }
    });
    expect(result.live).toEqual({ state: "working", at: 80 });
    expect(result.quiet).toEqual({ state: "idle", at: 0 });
    expect(result.firstReads).toEqual(["status:getAll:streaming"]);
    expect(result.secondReads).toEqual([]);
    expect(result.retained).toBe(true); expect(result.preview).toBe("unchanged"); expect(result.animated).toBe(false);
  } finally { await vite.close(); }
});

test("running avatars survive full/merge snapshots and clear on matching terminal updates", async ({ page }) => {
  const vite = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false } }); await vite.listen();
  try {
    await page.goto(vite.resolvedUrls!.local[0]!);
    const result = await page.evaluate(async () => {
      const storagePath = "/src/storage.ts", statePath = "/src/agent-state.ts";
      const { ClientCache } = await import(storagePath) as typeof import("../src/storage.js");
      const { agentSignal } = await import(statePath) as typeof import("../src/agent-state.js");
      const cache = new ClientCache("avatar-working-snapshot");
      const chat = { id: "chat", type: "direct" as const, title: "fixture", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
      const msg = (id: string, status: import("../../src/client-protocol/index.js").Message["status"], createdAt: number, version = 1) => ({ id, conversationId: chat.id, authorId: "bot", authorType: "bot" as const, blocks: [{ type: "text" as const, text: id }], status, createdAt, version });
      const state = async () => agentSignal([(await cache.activity()).chat]);
      const snapshot = async (id: string, seq: number, after: number, messages: ReturnType<typeof msg>[], merge = false) => {
        await cache.acceptSnapshot({ v: 1, type: "snapshot.begin", id, conversation: chat, seq, after, readSeq: seq, ...(merge ? { mode: "merge" as const } : {}) });
        for (const [index, message] of messages.entries()) await cache.acceptSnapshot({ v: 1, type: "snapshot.message", id, index, message, contentSeq: seq, contentAt: message.createdAt, unreadSeq: 0 });
        await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id, count: messages.length });
      };
      try {
        // Reverse creation order, like a snapshot ordered by IDs rather than time.
        await snapshot("initial", 10, 0, [msg("receipt", "complete", 3), msg("queued", "pending", 2), msg("run", "streaming", 1)]);
        const initial = await state();
        await snapshot("delta", 11, 10, [msg("attachment", "complete", 4)], true);
        const merged = await state();
        await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: 12, kind: "message.updated", payload: msg("run", "error", 1, 2), at: 12 });
        const ended = await state();
        await snapshot("restart", 13, 12, [msg("run2", "streaming", 5)], true);
        const restarted = await state();
        await snapshot("replace", 14, 13, [msg("receipt", "complete", 3)]);
        const replaced = await state();
        return { initial, merged, ended, restarted, replaced };
      } finally { cache.close(); }
    });
    expect(result.initial).toEqual({ state: "working", at: 1 });
    expect(result.merged).toEqual(result.initial);
    expect(result.ended.state).not.toBe("working");
    expect(result.restarted).toEqual({ state: "working", at: 5 });
    expect(result.replaced).toEqual({ state: "idle", at: 0 });
  } finally { await vite.close(); }
});

test("live done avatars remain out of phase after staggered and simultaneous completions", async ({ page }, info) => {
  const vite = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false } }); await vite.listen();
  try {
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.evaluate(async () => {
      const fixturePath = "/e2e/fixtures/avatar-phase.tsx";
      const { mountAvatarPhases } = await import(fixturePath);
      const container = document.createElement("div"); container.id = "phase-fixture"; document.body.append(container);
      (window as any).phaseFixture = mountAvatarPhases(container);
    });
    await page.waitForTimeout(1300);
    await page.evaluate(() => (window as any).phaseFixture.finish([0]));
    await expect(page.locator("#phase-fixture [data-agent-enter=done]")).toHaveCount(1);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).phaseFixture.finish([1, 2, 3, 4, 5]));
    await expect(page.locator("#phase-fixture [data-agent-enter=done]")).toHaveCount(6);
    await expect(page.locator("#phase-fixture [data-agent-enter]")).toHaveCount(0);
    const phases = await page.locator("#phase-fixture .profile-avatar").evaluateAll(nodes => nodes.map(node => {
      const animation = node.getAnimations().find(animation => (animation as CSSAnimation).animationName === "agent-bounce");
      return { delay: getComputedStyle(node).animationDelay, progress: animation?.effect?.getComputedTiming().progress ?? null };
    }));
    await info.attach("live-avatar-phases", { body: JSON.stringify(phases), contentType: "application/json" });
    expect(phases.every(phase => typeof phase.progress === "number")).toBe(true);
    expect(new Set(phases.map(phase => phase.delay)).size).toBeGreaterThan(2);
    const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
    expect(Math.max(...phases.slice(1).map(phase => distance(phases[0].progress!, phase.progress!)))).toBeGreaterThan(.1);
  } finally {
    if (!page.isClosed()) await page.evaluate(() => (window as any).phaseFixture?.unmount());
    await vite.close();
  }
});
