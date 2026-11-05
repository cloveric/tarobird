import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { HubServer } from "../../src/hub/server.js";
import { backupHubState, restoreHubState } from "../../src/hub/state-backup.js";
import { hashSecret } from "../../src/hub/auth.js";
import { MAX_FRAME_BYTES, type Message } from "../../src/client-protocol/index.js";
import type { ClientCache } from "../src/storage.js";

// The socket proxy supplies the offline fault; service-worker readiness is
// unrelated to snapshot/IndexedDB correctness and may never resolve in shells.
test.use({ serviceWorkers: "block" });

async function inspect(page: Page) {
  return page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(databaseName); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    try {
      const get = <T>(name: string) => new Promise<T[]>((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result as T[]); r.onerror = reject; });
      return { messages: (await get<Message & { activitySeq?: number; activityAt?: number }>("messages")).map(({ activitySeq: _seq, activityAt: _at, ...message }) => message), cursors: await get<number>("cursors"), staged: (await get("syncMessages")).length, outbox: (await get("outbox")).length };
    } finally { db.close(); }
  }, await singleHostCacheName(page));
}

test("large snapshots survive a mid-transfer reload, preserve the outbox and include concurrent live updates", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-browser-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  // Cut the actual socket on both engines; WebKit's context offline flag can
  // leave an existing WebSocket alive, which is not the desired network fault.
  let online = true; const pairs: [net.Socket, net.Socket][] = [];
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(new URL(hub.url).port), "127.0.0.1"); pairs.push([client, upstream]);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
    if (online) { client.pipe(upstream); upstream.pipe(client); }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const primary = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  let releaseFirst = () => {}, releaseSecond = () => {}, attempts = 0;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; }), secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const original = hub.store.snapshotFrames.bind(hub.store);
  hub.store.snapshotFrames = async function* (...args) {
    const attempt = ++attempts;
    for await (const frame of original(...args)) {
      yield frame;
      if (frame.type === "snapshot.message" && frame.index === 0) {
        if (attempt === 1) await firstHeld;
        if (attempt === 2) await secondHeld;
      }
    }
  };
  const sizes: number[] = []; let connections = 0;
  page.on("websocket", (socket) => { connections++; socket.on("framereceived", ({ payload }) => { sizes.push(Buffer.byteLength(String(payload))); }); });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','快照验收',?)", [hashSecret("synthetic-test-secret")]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "长离线恢复", "snapshot");
    const old = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "旧缓存仍可阅读" }] });
    await page.goto(hub.url); await page.getByLabel("Hub 地址", { exact: true }).fill(primary); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(page.locator(".message").getByText("旧缓存仍可阅读", { exact: true })).toBeVisible();
    online = false; for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); }
    await expect(page.locator(".offline-banner")).toBeVisible();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("恢复后只发一次"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await inspect(page)).outbox).toBe(1);
    const cached = await inspect(page); await page.goto("about:blank"); online = true;
    await hub.store.publishBotMessage("alpha", { id: old.id, conversationId: conversation.id, blocks: [], status: "deleted" });
    for (let i = 0; i < 6; i++) await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `历史消息 ${i}\n\n` + "正文".repeat(30_000) }] });
    for (let i = 0; i < 1001; i++) await hub.store.appendBotEvent("alpha", conversation.id, "turn.state", { phase: "thinking", i });
    await page.goto(hub.url);
    await expect.poll(async () => (await inspect(page)).staged).toBe(1);
    expect((await inspect(page)).messages).toEqual(cached.messages); expect((await inspect(page)).cursors).toEqual(cached.cursors);
    const beforeHold = connections;
    // A healthy paused catch-up must still answer heartbeats.
    await page.waitForTimeout(1500); expect(connections).toBe(beforeHold);
    await page.reload(); await expect.poll(() => attempts).toBe(2); releaseFirst();
    await expect.poll(async () => (await inspect(page)).staged).toBe(1);
    expect((await inspect(page)).messages).toEqual(cached.messages); expect((await inspect(page)).outbox).toBe(1);
    const live = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "同步期间的新回复" }] });
    releaseSecond();
    await expect.poll(async () => (await inspect(page)).outbox).toBe(0);
    await expect.poll(async () => (await inspect(page)).messages.some((m) => m.id === live.id)).toBe(true);
    const expected = (await hub.store.snapshot("owner", conversation.id)).messages.sort((a, b) => a.id.localeCompare(b.id));
    const result = await inspect(page);
    expect(result.messages.sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
    expect(expected.filter((m) => m.authorType === "user")).toHaveLength(1);
    expect(result.staged).toBe(0); expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(attempts).toBe(2);
    await info.attach("snapshot-recovery", { body: JSON.stringify({ attempts, messages: result.messages.length, maxFrameBytes: Math.max(...sizes), totalBytes: sizes.reduce((a, b) => a + b, 0), queuedMessagesSent: 1 }), contentType: "application/json" });
  } finally {
    releaseFirst(); releaseSecond(); await page.close();
    for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); }
    await new Promise<void>((resolve) => proxy.close(() => resolve())); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("snapshot staging rejects gaps and cross-conversation data, commits read state and removes stale rows atomically", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const conversation = { id: "conversation", type: "direct" as const, title: "Snapshot", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 };
      const old: Message = { id: "stale", conversationId: conversation.id, authorId: "alpha", authorType: "bot", blocks: [{ type: "text", text: "old" }], status: "complete", version: 1, createdAt: 1 };
      await cache.apply({ v: 1, type: "event", conversationId: conversation.id, seq: 1, kind: "message.created", payload: old, at: 1 });
      await cache.saveDraft(conversation.id, "unsent draft");
      await cache.enqueue({ v: 1, type: "message.send", conversationId: conversation.id, clientMsgId: "queued", text: "queued", attachments: [] });
      const begin = { v: 1 as const, type: "snapshot.begin" as const, id: "snapshot", conversation, seq: 2000, after: 1, readSeq: 1900 };
      const first = { v: 1 as const, type: "snapshot.message" as const, id: "snapshot", index: 0, message: { ...old, id: "already_read", version: 2 }, contentSeq: 1901, contentAt: 300, unreadSeq: 100 };
      const end = { v: 1 as const, type: "snapshot.end" as const, id: "snapshot", count: 2 };
      const failure = async (op: () => Promise<unknown>) => { try { await op(); return "accepted"; } catch (e) { return (e as Error).message; } };
      await cache.acceptSnapshot(begin); await cache.acceptSnapshot(first);
      const gap = await failure(() => cache.acceptSnapshot({ ...first, index: 2 }));
      const wrongConversation = await failure(() => cache.acceptSnapshot({ ...first, index: 1, message: { ...first.message, id: "wrong", conversationId: "other" } }));
      const incomplete = await failure(() => cache.acceptSnapshot(end));
      const unchanged = { messages: await cache.messages(conversation.id), cursors: await cache.cursors() };
      await cache.acceptSnapshot({ ...first, index: 1, message: { ...old, id: "unread", version: 3, blocks: [{ type: "text", text: "newest" }] }, contentSeq: 2000, contentAt: 400, unreadSeq: 1999 });
      await cache.acceptSnapshot(end);
      const state = { messages: await cache.messages(conversation.id), cursors: await cache.cursors(), activity: await cache.activity(), outbox: await cache.outbox(), draft: await cache.draft(conversation.id) };
      const stale = await failure(() => cache.acceptSnapshot(begin));
      await cache.acceptSnapshot({ ...begin, id: "restored", after: 2000, seq: 0, readSeq: 0 });
      await cache.acceptSnapshot({ ...end, id: "restored", count: 0 });
      return { gap, wrongConversation, incomplete, unchanged, state, stale, restored: { messages: await cache.messages(conversation.id), cursors: await cache.cursors() } };
    });
    expect(result.gap).toBe("snapshot_message_mismatch"); expect(result.wrongConversation).toBe("snapshot_message_mismatch"); expect(result.incomplete).toBe("snapshot_incomplete");
    expect(result.unchanged.messages.map((m) => m.id)).toEqual(["stale"]); expect(result.unchanged.cursors).toEqual({ conversation: 1 });
    expect(result.state.messages.map((m) => m.id).sort()).toEqual(["already_read", "unread"]); expect(result.state.cursors).toEqual({ conversation: 2000 });
    expect(result.state.activity.conversation).toMatchObject({ preview: "newest", at: 400, unread: { unread: 1999 }, lastContentSeq: 2000 });
    expect(result.state.outbox).toHaveLength(1); expect(result.state.draft).toBe("unsent draft"); expect(result.stale).toBe("snapshot_cursor_mismatch");
    expect(result.restored).toEqual({ messages: [], cursors: { conversation: 0 } });
  } finally { await server.close(); }
});

test("incremental snapshots preserve cached rows and atomically reconcile deletes, reads and interrupted staging", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const conversation = { id: "merge", type: "direct" as const, title: "Merge", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 };
      const message = (id: string, text: string, at: number): Message => ({ id, conversationId: conversation.id, authorId: "alpha", authorType: "bot", blocks: [{ type: "text", text }], status: "complete", version: 1, createdAt: at });
      const first = message("retained", "retained old history", 10), second = message("hidden", "delete this latest reply", 20);
      await cache.apply({ v: 1, type: "event", conversationId: conversation.id, seq: 1, kind: "message.created", payload: first, at: 10 });
      await cache.apply({ v: 1, type: "event", conversationId: conversation.id, seq: 2, kind: "message.created", payload: second, at: 20 });
      await cache.saveDraft(conversation.id, "preserve draft");
      await cache.enqueue({ v: 1, type: "message.send", conversationId: conversation.id, clientMsgId: "queued-merge", text: "queued", attachments: [] });
      const begin = { v: 1 as const, type: "snapshot.begin" as const, mode: "merge" as const, id: "delta", conversation, seq: 100, after: 2, readSeq: 1 };
      const tombstone = { v: 1 as const, type: "snapshot.message" as const, id: "delta", index: 0, message: { ...second, status: "deleted" as const, version: 2, blocks: [] }, contentSeq: 2, contentAt: 20, unreadSeq: 2 };
      await cache.acceptSnapshot(begin); await cache.acceptSnapshot(tombstone);
      const partial = { messages: await cache.messages(conversation.id), cursors: await cache.cursors() };
      await cache.discardSnapshot();
      const interrupted = { messages: await cache.messages(conversation.id), cursors: await cache.cursors() };
      await cache.acceptSnapshot(begin); await cache.acceptSnapshot(tombstone);
      await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "delta", count: 1 });
      const deleted = { messages: await cache.messages(conversation.id), cursors: await cache.cursors(), activity: await cache.activity() };
      const latest = message("latest", "new reply", 110);
      await cache.acceptSnapshot({ ...begin, id: "next", after: 100, seq: 200, readSeq: 100 });
      await cache.acceptSnapshot({ ...tombstone, id: "next", message: latest, contentSeq: 199, contentAt: 110, unreadSeq: 199 });
      await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "next", count: 1 });
      const final = { messages: await cache.messages(conversation.id), cursors: await cache.cursors(), activity: await cache.activity(), draft: await cache.draft(conversation.id), outbox: await cache.outbox() };
      await cache.apply({ v: 1, type: "event", conversationId: conversation.id, seq: 201, kind: "message.updated", payload: { ...latest, version: 2, blocks: [{ type: "text", text: "live after delta" }] }, at: 120 });
      return { partial, interrupted, deleted, final, live: await cache.messages(conversation.id) };
    });
    expect(result.partial).toEqual(result.interrupted);
    expect(result.partial.cursors).toEqual({ merge: 2 });
    expect(result.deleted.cursors).toEqual({ merge: 100 });
    expect(result.deleted.messages.find(m => m.id === "retained")?.blocks).toEqual([{ type: "text", text: "retained old history" }]);
    expect(result.deleted.messages.find(m => m.id === "hidden")).toMatchObject({ status: "deleted", blocks: [] });
    expect(result.deleted.activity.merge).toMatchObject({ preview: "retained old history", at: 10, unread: {}, lastContentSeq: 1 });
    expect(result.final.messages).toHaveLength(3);
    expect(result.final.activity.merge).toMatchObject({ preview: "new reply", unread: { latest: 199 }, lastContentSeq: 199 });
    expect(result.final.cursors).toEqual({ merge: 200 });
    expect(result.final.draft).toBe("preserve draft"); expect(result.final.outbox).toHaveLength(1);
    expect(result.live.find(m => m.id === "latest")?.blocks).toEqual([{ type: "text", text: "live after delta" }]);
  } finally { await server.close(); }
});

test("selected chat sends and receives while another history transfer is paused", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "independent-sync-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release = () => {}, held = false;
  const pause = new Promise<void>(resolve => { release = resolve; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','同步助手','fixture',1)");
    const live = await hub.store.createConversation("owner", ["alpha"], "当前对话", "current");
    const history = await hub.store.createConversation("owner", ["alpha"], "其他历史", "other");
    await hub.store.publishBotMessage("alpha", { conversationId: live.id, blocks: [{ type: "text", text: "当前对话已缓存" }] });
    const old = await hub.store.publishBotMessage("alpha", { conversationId: history.id, blocks: [{ type: "text", text: "历史已缓存" }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await selectConversation(page, "当前对话");
    await expect(page.locator(".message").getByText("当前对话已缓存", { exact: true })).toBeVisible();
    const databaseName = await singleHostCacheName(page);
    await page.goto("about:blank");
    for (let i = 2; i <= 90; i++) await hub.store.publishBotMessage("alpha", { id: old.id, conversationId: history.id, version: i, blocks: [{ type: "text", text: `历史更新 ${i}` }] });
    const original = hub.store.snapshotFrames.bind(hub.store);
    hub.store.snapshotFrames = async function* (...args) {
      for await (const frame of original(...args)) {
        yield frame;
        if (args[1] === history.id && frame.type === "snapshot.message") { held = true; await pause; }
      }
    };
    await page.goto(hub.url);
    await expect.poll(() => held).toBe(true);
    await expect(page.locator(".history-sync-status").getByText("同步历史 1/2", { exact: true })).toBeVisible();
    // Pass the initial route-health refresh: it used to accidentally flush
    // buffered live events and hide the global-sync UI invalidation bug.
    await page.waitForTimeout(3000);
    await hub.store.publishBotMessage("alpha", { conversationId: live.id, blocks: [{ type: "text", text: "补历史期间的新回复" }] });
    await expect(page.locator(".message").getByText("补历史期间的新回复", { exact: true })).toBeVisible({ timeout: 1000 });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("补历史期间仍可发送");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", live.id)).messages.some(m => m.blocks.some(b => b.type === "text" && b.text === "补历史期间仍可发送"))).toBe(true);
    await expect.poll(async () => page.evaluate(async name => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = reject; });
      try { return await new Promise<number>(resolve => { const req = db.transaction("outbox").objectStore("outbox").count(); req.onsuccess = () => resolve(req.result); }); } finally { db.close(); }
    }, databaseName)).toBe(0);
    await page.screenshot({ path: info.outputPath("current-chat-during-history.png") });
    release();
    await expect(page.locator(".history-sync-status")).toHaveCount(0);
    await selectConversation(page, "其他历史");
    await expect(page.locator(".message").getByText("历史更新 90", { exact: true })).toBeVisible();
  } finally { release(); await page.goto("about:blank").catch(() => undefined); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("restore lineages commit per conversation with snapshots, survive interruption and fence discarded staging", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const other = new (cache.constructor as typeof ClientCache)(cache.databaseName);
      const firstLineage = crypto.randomUUID(), secondLineage = crypto.randomUUID();
      const conversation = { id: "restored", type: "direct" as const, title: "Restore", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 };
      const message: Message = { id: "ghost", conversationId: conversation.id, authorId: "alpha", authorType: "bot", blocks: [{ type: "text", text: "discarded" }], status: "complete", version: 1, createdAt: 1 };
      const failure = async (op: () => Promise<unknown>) => { try { await op(); return "accepted"; } catch (e) { return (e as Error).message; } };
      try {
        for (let seq = 1; seq <= 5; seq++) await cache.apply({ v: 1, type: "event", conversationId: conversation.id, seq, kind: "message.created", payload: message, at: 1 });
        for (let seq = 1; seq <= 10; seq++) await cache.apply({ v: 1, type: "event", conversationId: "other", seq, kind: "message.created", payload: { ...message, id: "other-ghost", conversationId: "other" }, at: 1 });
        await cache.saveDraft(conversation.id, "keep unsent draft");
        await cache.enqueue({ v: 1, type: "message.send", conversationId: conversation.id, clientMsgId: "queued-restore", text: "queued", attachments: [] });
        const begin = { v: 1 as const, type: "snapshot.begin" as const, id: "restore", conversation, seq: 5, after: 5, readSeq: 0, lineage: firstLineage };
        const item = { v: 1 as const, type: "snapshot.message" as const, id: begin.id, index: 0, message: { ...message, id: "fresh", blocks: [{ type: "text" as const, text: "restored" }] }, contentSeq: 5, unreadSeq: 5 };
        const end = { v: 1 as const, type: "snapshot.end" as const, id: begin.id, count: 1 };
        // The older handle has a staged snapshot from the discarded timeline.
        await cache.acceptSnapshot({ ...begin, id: "old", lineage: undefined, seq: 50 });
        await cache.acceptSnapshot({ ...item, id: "old", message });
        await other.acceptSnapshot(begin); await other.acceptSnapshot(item);
        const partial = await other.syncResume();
        await other.discardSnapshot();
        const interrupted = await other.syncResume();
        await other.acceptSnapshot(begin); await other.acceptSnapshot(item); await other.acceptSnapshot(end);
        const committed = await other.syncResume();
        const stale = await failure(() => cache.acceptSnapshot({ ...end, id: "old" }));
        const wrongMerge = await failure(() => other.acceptSnapshot({ ...begin, id: "wrong", mode: "merge", lineage: secondLineage, seq: 6 }));
        await other.acceptSnapshot({ ...begin, id: "other", conversation: { ...conversation, id: "other" }, after: 10, seq: 0 });
        await other.acceptSnapshot({ ...end, id: "other", count: 0 });
        const both = await other.syncResume();
        // A second restore may reset sequence numbers below the cached value.
        await other.acceptSnapshot({ ...begin, id: "again", lineage: secondLineage, seq: 3 });
        await other.acceptSnapshot({ ...item, id: "again", contentSeq: 3, unreadSeq: 3 });
        const secondPartial = await other.syncResume();
        await other.acceptSnapshot({ ...end, id: "again" });
        await other.apply({ v: 1, type: "event", conversationId: conversation.id, seq: 4, kind: "message.updated", payload: { ...item.message, version: 2, blocks: [{ type: "text", text: "live after restore" }] }, at: 4 });
        return { firstLineage, secondLineage, partial, interrupted, committed, stale, wrongMerge, both, secondPartial, final: await other.syncResume(), messages: await other.messages(conversation.id), otherMessages: await other.messages("other"), draft: await other.draft(conversation.id), outbox: await other.outbox() };
      } finally { await other.close(); }
    });
    expect(result.partial).toEqual(result.interrupted);
    expect(result.partial).toEqual({ cursors: { restored: 5, other: 10 }, syncLineages: {} });
    expect(result.committed).toEqual({ cursors: { restored: 5, other: 10 }, syncLineages: { restored: result.firstLineage } });
    expect(result.stale).toBe("snapshot_lineage_mismatch"); expect(result.wrongMerge).toBe("snapshot_lineage_mismatch");
    expect(result.both).toEqual({ cursors: { restored: 5, other: 0 }, syncLineages: { restored: result.firstLineage, other: result.firstLineage } });
    expect(result.secondPartial).toEqual(result.both);
    expect(result.final).toEqual({ cursors: { restored: 4, other: 0 }, syncLineages: { restored: result.secondLineage, other: result.firstLineage } });
    expect(result.messages).toHaveLength(1); expect(result.messages[0]).toMatchObject({ id: "fresh", blocks: [{ type: "text", text: "live after restore" }] });
    expect(result.otherMessages).toEqual([]); expect(result.draft).toBe("keep unsent draft"); expect(result.outbox).toHaveLength(1);
  } finally { await server.close(); }
});


test("the App replaces ghost messages after official restore and resumes the committed lineage on reconnect", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-restore-browser-")), stateDir = path.join(root, "hub"), backup = path.join(root, "backup");
  let hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  const url = hub.url, port = Number(new URL(url).port);
  let received: Record<string, unknown>[] = [], sent: Record<string, unknown>[] = [];
  page.on("websocket", socket => {
    socket.on("framereceived", ({ payload }) => { try { received.push(JSON.parse(String(payload))); } catch { /* Transport fragments are irrelevant to this small fixture. */ } });
    socket.on("framesent", ({ payload }) => { try { sent.push(JSON.parse(String(payload))); } catch { /* Ignore non-JSON frames. */ } });
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','恢复验收',?)", [hashSecret("synthetic-restore-secret")]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "恢复聊天记录", "restore-app");
    await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "保留的回复" }] });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect.poll(async () => (await inspect(page)).messages.length).toBe(1);
    await page.goto("about:blank"); await hub.close(); await backupHubState(stateDir, backup);
    hub = await HubServer.start({ stateDir, port, clientDir: path.resolve("dist") });
    const ghosts: string[] = [];
    for (let i = 0; i < 5; i++) ghosts.push((await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `恢复前已放弃 ${i}` }] })).id);
    await page.goto(url); await expect.poll(async () => (await inspect(page)).messages.length).toBe(6);
    await page.goto("about:blank"); await hub.close(); await rename(stateDir, path.join(root, "discarded")); await restoreHubState(backup, stateDir);
    hub = await HubServer.start({ stateDir, port, clientDir: path.resolve("dist") });
    for (let i = 0; i < 100; i++) await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `恢复后的回复 ${i}` }] });
    const expected = (await hub.store.snapshot("owner", conversation.id)).messages.map(m => m.id).sort();
    received = []; sent = []; await page.goto(url);
    await expect.poll(async () => (await inspect(page)).messages.map(m => m.id).sort()).toEqual(expected);
    expect((await inspect(page)).messages.some(m => ghosts.includes(m.id))).toBe(false);
    const begin = received.find(frame => frame.type === "snapshot.begin");
    expect(begin).toMatchObject({ after: (sent.find(frame => frame.type === "hello")!.cursors as Record<string, number>)[conversation.id], seq: expect.any(Number), lineage: expect.any(String) }); expect(begin).not.toHaveProperty("mode");
    await expect.poll(() => received.some(frame => frame.type === "sync.complete")).toBe(true);
    received = []; sent = []; await page.reload();
    await expect.poll(() => received.some(frame => frame.type === "sync.complete")).toBe(true);
    expect(sent.find(frame => frame.type === "hello")).toMatchObject({ cursors: { [conversation.id]: expect.any(Number) }, syncLineages: { [conversation.id]: begin!.lineage } });
    expect(received.some(frame => frame.type === "snapshot.begin")).toBe(false);
    const live = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "恢复后继续聊天" }] });
    await expect.poll(async () => (await inspect(page)).messages.some(m => m.id === live.id)).toBe(true);
    // Emulate the previous Host protocol on the same authenticated transport:
    // it neither advertises lineage nor includes it in merge snapshots.
    await page.goto("about:blank");
    const sendClient = Reflect.get(hub, "sendClient") as (client: unknown, frame: unknown) => Promise<void>;
    Reflect.set(hub, "sendClient", async (client: unknown, value: Record<string, unknown>) => {
      const frame = { ...value };
      if (frame.type === "ready") frame.serverCapabilities = (frame.serverCapabilities as string[]).filter(capability => capability !== "sync.lineage.v1");
      if (frame.type === "snapshot.begin") delete frame.lineage;
      await sendClient.call(hub, client, frame);
    });
    for (let i = 0; i < 100; i++) await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `旧主机增量回复 ${i}` }] });
    const legacyExpected = (await hub.store.snapshot("owner", conversation.id)).messages.map(m => m.id).sort();
    received = []; sent = []; await page.goto(url);
    await expect.poll(async () => (await inspect(page)).messages.map(m => m.id).sort()).toEqual(legacyExpected);
    const legacyBegin = received.find(frame => frame.type === "snapshot.begin");
    expect(legacyBegin).toMatchObject({ mode: "merge" }); expect(legacyBegin).not.toHaveProperty("lineage");
    await expect.poll(() => received.some(frame => frame.type === "sync.complete")).toBe(true);
    received = []; sent = []; await page.reload();
    await expect.poll(() => received.some(frame => frame.type === "sync.complete")).toBe(true);
    expect(sent.find(frame => frame.type === "hello")).toMatchObject({ syncLineages: { [conversation.id]: begin!.lineage } });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("socket lineage fences reject stale event drains and late snapshot starts without rolling back a concurrent restored head", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const other = new (cache.constructor as typeof ClientCache)(cache.databaseName), lineage = crypto.randomUUID();
      const conversation = (id: string) => ({ id, type: "direct" as const, title: id, ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 });
      const message = (id: string, restored = false): Message => ({ id: `${id}-${restored ? "fresh" : "ghost"}`, conversationId: id, authorId: "alpha", authorType: "bot", blocks: [{ type: "text", text: restored ? "fresh" : "discarded" }], status: "complete", version: 1, createdAt: 1 });
      const begin = (id: string, snapshot: string, seq = 5) => ({ v: 1 as const, type: "snapshot.begin" as const, id: snapshot, conversation: conversation(id), after: 5, seq, readSeq: 0, lineage });
      const end = (id: string, count: number) => ({ v: 1 as const, type: "snapshot.end" as const, id, count });
      const failure = async (op: () => Promise<unknown>) => { try { await op(); return "accepted"; } catch (e) { return (e as Error).message; } };
      try {
        for (const id of ["event", "late", "race"]) for (let seq = 1; seq <= 5; seq++) await cache.apply({ v: 1, type: "event", conversationId: id, seq, kind: "message.created", payload: message(id), at: 1 });
        for (const id of ["event", "late"]) {
          await other.acceptSnapshot(begin(id, id));
          await other.acceptSnapshot({ v: 1, type: "snapshot.message", id, index: 0, message: message(id, true), contentSeq: 5, unreadSeq: 5 });
          await other.acceptSnapshot(end(id, 1));
        }
        const staleEvent = await failure(() => cache.apply({ v: 1, type: "event", conversationId: "event", seq: 6, kind: "message.created", payload: message("event"), at: 1 }, undefined, { lineage: undefined }));
        const lateBegin = await failure(() => cache.acceptSnapshot({ ...begin("late", "late-old", 6), lineage: undefined }, { lineage: undefined }));
        await cache.acceptSnapshot(begin("race", "low", 3), { lineage: undefined });
        await other.acceptSnapshot(begin("race", "high", 5), { lineage: undefined });
        await other.acceptSnapshot({ v: 1, type: "snapshot.message", id: "high", index: 0, message: message("race", true), contentSeq: 5, unreadSeq: 5 });
        await other.acceptSnapshot(end("high", 1)); await cache.acceptSnapshot(end("low", 0));
        return { staleEvent, lateBegin, eventMessages: await other.messages("event"), raceMessages: await other.messages("race"), resume: await other.syncResume(), lineage };
      } finally { other.close(); }
    });
    expect.soft(result.staleEvent).toBe("sync_lineage_mismatch");
    expect.soft(result.lateBegin).toBe("snapshot_lineage_mismatch");
    expect.soft(result.eventMessages.map(m => m.id)).toEqual(["event-fresh"]);
    expect.soft(result.raceMessages.map(m => m.id)).toEqual(["race-fresh"]);
    expect.soft(result.resume.cursors).toEqual({ event: 5, late: 5, race: 5 });
    expect(result.resume.syncLineages).toEqual({ event: result.lineage, late: result.lineage, race: result.lineage });
  } finally { await server.close(); }
});
