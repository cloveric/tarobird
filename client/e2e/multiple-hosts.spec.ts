import { pairFixtureHost } from "./fixtures/pair-registered-host.js";
import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { Message } from "../../src/client-protocol/index.js";
import type { QuestionData } from "../src/question-draft.js";
import type { multipleHosts } from "./fixtures/multiple-hosts.js";

declare global { interface Window { multipleHosts: typeof multipleHosts } }
const key = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
let server: ViteDevServer, url: string;
test.beforeEach(async ({ page }) => {
  server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen(); url = server.resolvedUrls!.local[0]!;
  await page.goto(url + "e2e/fixtures/multiple-hosts.html"); await page.waitForFunction(() => !!window.multipleHosts);
});
test.afterEach(async ({ page }) => { await page.close(); await server.close(); });

test("same IDs remain isolated in drafts, queues, files, profiles, forms and snapshot staging", async ({ page }) => {
  const data: QuestionData = { version: 1, requestId: "same_request", questions: [{ question: "选择任务", header: "任务", multiSelect: false, required: true, allowFreeText: true, options: [{ label: "搜索" }] }] };
  const message: Message = { id: "same_message", conversationId: "same_conversation", authorId: "alpha", authorType: "bot", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "card", elements: [{ type: "form", extra: { tarocub_questions: data }, children: [{ type: "button", name: "askq_submit", actionId: "answer", extra: { form_action_type: "submit" } }] }] }] };
  const result = await page.evaluate(async ({ keys, message, data }) => {
    const f = window.multipleHosts, records = [];
    for (const [i, hubKey] of keys.entries()) {
      const identity = { deviceId: `device_${i}`, name: "同名电脑", publicKey: "fixture", hubPublicKey: hubKey, routes: [] };
      records.push(await f.registry.add(identity, "同名电脑"));
    }
    const [a, b] = await Promise.all(records.map((r) => f.registry.open(r.id)));
    const conversation = { id: "same_conversation", type: "direct" as const, title: "同名对话", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 };
    const draftKey = f.questionDraftKey(message.id, data);
    for (const [i, handle] of [a!, b!].entries()) {
      const c = handle.cache;
      await c.saveConversations([conversation]); await c.saveDraft(conversation.id, `draft_${i}`);
      await c.saveSelectedConversation(conversation.id); await c.savePins([`pin_${i}`]);
      await c.saveAttachment("same_attachment", new Blob([`file_${i}`]));
      await c.saveProfiles({ user: { id: "owner", name: `user_${i}`, role: "owner" }, avatars: [] }, handle.identity);
      await c.saveBotNames([{ id: "alpha", name: `bot_${i}`, engine: "antigravity", model: i === 0 ? "gemini-3.7-pro" : "claude-opus-5-5" }], handle.identity);
      await c.apply({ v: 1, type: "event", conversationId: conversation.id, seq: 1, kind: "message.created", payload: message, at: 1 });
      await c.saveQuestionDraft(message.id, draftKey, { values: { q0_other: `answer_${i}` }, step: 0 }, handle.identity);
      await c.enqueue({ v: 1, type: "message.send", conversationId: conversation.id, clientMsgId: "same_queue_id", text: `queued_${i}`, attachments: [] });
      await c.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "same_snapshot", conversation, seq: 10 + i, after: 1, readSeq: 0 });
      await c.acceptSnapshot({ v: 1, type: "snapshot.message", id: "same_snapshot", index: 0, message: { ...message, version: 2 + i }, contentSeq: 10 + i, unreadSeq: 10 + i });
    }
    await a!.cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "same_snapshot", count: 1 });
    const bBefore = (await b!.cache.messages(conversation.id))[0]!.version;
    await b!.cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "same_snapshot", count: 1 });
    await a!.cache.acknowledge("same_queue_id"); await a!.cache.markIdentityRevoked(a!.identity);
    const inspect = async (h: typeof a) => ({ draft: await h!.cache.draft(conversation.id), file: await (await h!.cache.attachment("same_attachment"))!.text(),
      pins: await h!.cache.pins(), selected: await h!.cache.selectedConversation(), bots: await h!.cache.botNames(), profiles: await h!.cache.profiles(),
      version: (await h!.cache.messages(conversation.id))[0]!.version, cursors: await h!.cache.cursors(), activity: await h!.cache.activity(),
      form: await h!.cache.questionDraft(message.id, draftKey, h!.identity), outbox: await h!.cache.outbox(), revoked: await h!.cache.identityRevoked(h!.identity) });
    return { a: await inspect(a), b: await inspect(b), bBefore, legacy: await f.cache.identity() };
  }, { keys: [key(), key()], message, data });
  expect(result.bBefore).toBe(1); expect(result.legacy).toBeUndefined();
  for (const [i, item] of [result.a, result.b].entries()) {
    expect(item).toMatchObject({ draft: `draft_${i}`, file: `file_${i}`, pins: [`pin_${i}`], selected: "same_conversation", bots: [{ id: "alpha", name: `bot_${i}`, engine: "antigravity", model: i === 0 ? "gemini-3.7-pro" : "claude-opus-5-5" }], profiles: { user: { name: `user_${i}` } }, version: 2 + i,
      cursors: { same_conversation: 10 + i }, form: { values: { q0_other: `answer_${i}` } }, revoked: i === 0 });
    expect(item.activity.same_conversation?.unread).toEqual({ same_message: 10 + i });
  }
  expect(result.a.outbox).toHaveLength(0); expect(result.b.outbox).toHaveLength(1); expect(result.b.outbox[0]?.frame).toMatchObject({ text: "queued_1" });
});

test("pending selection hints are scoped to host, pairing and reset generation and tolerate blocked storage", async ({ page }) => {
  const result = await page.evaluate(async (keys) => {
    const f = window.multipleHosts;
    const identity = { deviceId: 'selection_device', name: 'A', publicKey: 'fixture', hubPublicKey: keys[0], routes: [] };
    const other = { ...identity, hubPublicKey: keys[1] };
    const a = new f.ClientCache('selection-a'), b = new f.ClientCache('selection-b');
    await a.saveIdentity(identity); await b.saveIdentity(other);
    const pending = a.saveSelectedConversation('old-chat', identity);
    const hints = Object.entries(localStorage).filter(([key]) => key.startsWith('tarocub-selection:'));
    await pending;
    const afterCommit = hints.every(([key]) => localStorage.getItem(key) === null);
    // Recreate the tiny record left by a page which closed before IDB committed.
    for (const [key, value] of hints) localStorage.setItem(key, value);
    const otherHost = await b.selectedConversation();
    await a.beginReset();
    const afterReset = hints.every(([key]) => localStorage.getItem(key) === null);
    const fresh = new f.ClientCache(a.databaseName);
    await fresh.finishReset(); await fresh.saveIdentity(identity);
    // Even re-pairing the exact same identity cannot reuse the old generation.
    for (const [key, value] of hints) localStorage.setItem(key, value);
    const resetSelection = await fresh.selectedConversation();
    await fresh.saveSelectedConversation('new-chat', identity);
    let staleError = '';
    try { await a.saveSelectedConversation('stale-chat', identity); } catch (error) { staleError = (error as Error).message; }
    const current = await fresh.selectedConversation();
    const again = fresh.saveSelectedConversation('forgotten-chat', identity);
    const newHints = Object.entries(localStorage).filter(([key]) => key.startsWith('tarocub-selection:'));
    await again;
    for (const [key, value] of newHints) localStorage.setItem(key, value);
    await fresh.forgetIdentity();
    const afterForget = newHints.every(([key]) => localStorage.getItem(key) === null);
    await fresh.saveIdentity({ ...identity, deviceId: 'replacement', publicKey: 'replacement' });
    for (const [key, value] of newHints) localStorage.setItem(key, value);
    const replacedSelection = await fresh.selectedConversation();
    const replacement = { ...identity, deviceId: 'replacement', publicKey: 'replacement' };
    await fresh.saveSelectedConversation('replacement-chat', replacement);
    let stalePairingError = '';
    try { await fresh.saveSelectedConversation('stale-pairing-chat', identity); } catch (error) { stalePairingError = (error as Error).message; }
    const afterStalePairing = await fresh.selectedConversation();
    const setItem = Storage.prototype.setItem, getItem = Storage.prototype.getItem;
    let blockedSelection = '';
    try {
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      await fresh.saveSelectedConversation('works-without-hint', { ...identity, deviceId: 'replacement', publicKey: 'replacement' });
      blockedSelection = await fresh.selectedConversation();
    } finally { Storage.prototype.setItem = setItem; Storage.prototype.getItem = getItem; }
    a.close(); b.close(); fresh.close();
    return { hintCount: hints.length, afterCommit, otherHost, afterReset, resetSelection, staleError, current, afterForget, replacedSelection, stalePairingError, afterStalePairing, blockedSelection };
  }, [key(), key()]);
  expect(result).toEqual({ hintCount: 1, afterCommit: true, otherHost: '', afterReset: true, resetSelection: '', staleError: 'local_reset_in_progress', current: 'new-chat', afterForget: true, replacedSelection: '', stalePairingError: 'host_cache_identity_mismatch', afterStalePairing: 'replacement-chat', blockedSelection: 'works-without-hint' });
});

test("an older A selection commit cannot clear the pending hint for a newer A after B", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cache = new window.multipleHosts.ClientCache('selection-aba');
    const identity = { deviceId: 'aba-device', name: 'A', publicKey: 'fixture', routes: [] };
    await cache.saveIdentity(identity);
    let releaseB = false, beganB!: () => void;
    const busy = new Promise<void>(resolve => { beganB = resolve; });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (this.name === 'settings' && key === 'selectedConversation' && value === 'B') {
        // B owns the real write lock while the third selection waits behind it.
        const keepBusy = () => { this.get('selection-aba-fixture').onsuccess = () => { if (!releaseB) keepBusy(); }; };
        keepBusy(); beganB();
      }
      return request;
    };
    const first = cache.saveSelectedConversation('A', identity);
    const second = cache.saveSelectedConversation('B', identity);
    const third = cache.saveSelectedConversation('A', identity);
    let hint: unknown;
    try {
      await first; await busy;
      const raw = Object.entries(localStorage).find(([key]) => key.startsWith('tarocub-selection:'))?.[1];
      if (raw) { try { hint = JSON.parse(raw); } catch { hint = { id: raw }; } }
    } finally { releaseB = true; await Promise.all([second, third]); IDBObjectStore.prototype.put = put; }
    const selected = await cache.selectedConversation(); cache.close();
    return { hint, selected };
  });
  expect(result.hint).toMatchObject({ id: 'A' });
  expect(result.selected).toBe('A');
});

test("legacy import is in place; concurrent tabs cannot replace an existing pairing by name or route", async ({ page, context }) => {
  const legacyKey = key(), secondKey = key();
  await page.evaluate(async (hubPublicKey) => {
    const { cache } = window.multipleHosts;
    await cache.saveIdentity({ deviceId: "legacy_device", name: "旧设备", publicKey: "fixture", hubPublicKey, routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }] });
    await cache.saveDraft("same_conversation", "不能丢的草稿"); await cache.saveAttachment("legacy_file", new Blob(["旧附件"]));
    await cache.enqueue({ v: 1, type: "message.send", conversationId: "same_conversation", clientMsgId: "old_queued", text: "旧排队消息", attachments: [] });
  }, legacyKey);
  const tab = await context.newPage();
  try {
    await tab.goto(url + "e2e/fixtures/multiple-hosts.html"); await tab.waitForFunction(() => !!window.multipleHosts);
    const imported = await Promise.all([page, tab].map((p) => p.evaluate(() => window.multipleHosts.registry.importLegacy("Mac mini"))));
    expect(imported[0]).toEqual(imported[1]); expect(imported[0]?.databaseName).toBe("tarocub-v1");
    const add = (p: Page, deviceId: string) => p.evaluate(async ({ hubPublicKey, deviceId }) => {
      try { return { host: await window.multipleHosts.registry.add({ deviceId, name: "设备", publicKey: "fixture", hubPublicKey, routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }] }, "Mac mini") }; }
      catch (e) { return { error: (e as Error).message }; }
    }, { hubPublicKey: secondKey, deviceId });
    const added = await Promise.all([add(page, "new_a"), add(tab, "new_b")]);
    expect(added.filter((r) => r.host)).toHaveLength(1); expect(added.find((r) => r.error)?.error).toBe("host_already_registered");
    const result = await page.evaluate(async (id) => {
      const f = window.multipleHosts; await f.registry.rename(id, "重命名后的主机"); const h = await f.registry.open(id);
      return { records: await f.registry.list(), identity: h.identity.deviceId, draft: await h.cache.draft("same_conversation"), file: await (await h.cache.attachment("legacy_file"))!.text(), queue: (await h.cache.outbox()).length };
    }, imported[0]!.id);
    expect(result).toMatchObject({ identity: "legacy_device", draft: "不能丢的草稿", file: "旧附件", queue: 1 }); expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.id === imported[0]?.id)?.name).toBe("重命名后的主机");
    expect(result.records.every((r) => !("pendingIdentity" in r))).toBe(true);
    expect(await page.evaluate(async (hubPublicKey) => {
      try { await window.multipleHosts.registry.add({ deviceId: "replace", name: "不同名字", publicKey: "fixture", hubPublicKey, routes: [{ name: "VPS", url: "https://different.example.com" }] }, "另一个名字"); return "accepted"; } catch (e) { return (e as Error).message; }
    }, legacyKey)).toBe("host_already_registered");
  } finally { await tab.close(); }
});

test("interrupted setup keeps its pairing and recovers without clearing another host", async ({ page }) => {
  const result = await page.evaluate(async (keys) => {
    const f = window.multipleHosts;
    const b = await f.registry.add({ deviceId: "device_b", name: "B", publicKey: "fixture", hubPublicKey: keys[1], routes: [] }, "B");
    await (await f.registry.open(b.id)).cache.saveDraft("same_conversation", "B preserved");
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) { if (this.name === "settings" && args[1] === "identity") { this.transaction.abort(); throw new Error("injected_setup_failure"); } return put.apply(this, args); };
    let error = "";
    try { await f.registry.add({ deviceId: "device_a", keyRef: "device_a", name: "A", publicKey: "fixture", hubPublicKey: keys[0], routes: [] }, "A"); } catch (e) { error = (e as Error).message; }
    finally { IDBObjectStore.prototype.put = put; }
    return { error, records: await f.registry.list() };
  }, [key(), key()]);
  expect(result.error).toBe("injected_setup_failure"); expect(result.records.map((r) => r.state).sort()).toEqual(["preparing", "ready"]);
  await page.reload(); await page.waitForFunction(() => !!window.multipleHosts);
  const restored = await page.evaluate(async () => {
    const f = window.multipleHosts; await f.registry.recoverPreparations(); const records = await f.registry.list();
    return Promise.all(records.map(async (r) => { const h = await f.registry.open(r.id); return { name: r.name, state: r.state, keyRef: h.identity.keyRef, draft: await h.cache.draft("same_conversation") }; }));
  });
  expect(restored.find((r) => r.name === "A")).toEqual({ name: "A", state: "ready", keyRef: "device_a", draft: "" });
  expect(restored.find((r) => r.name === "B")).toMatchObject({ state: "ready", draft: "B preserved" });
});

test("removal retries only one host, fences its delayed writes and rejects stale retries after re-pairing", async ({ page, context }) => {
  const keys = [key(), key()];
  const records = await page.evaluate(async (keys) => {
    const f = window.multipleHosts; const records = [];
    for (const [i, hubPublicKey] of keys.entries()) {
      const host = await f.registry.add({ deviceId: `device_${i}`, keyRef: `device_${i}`, name: `host_${i}`, publicKey: "fixture", hubPublicKey, routes: [] }, `host_${i}`);
      const h = await f.registry.open(host.id); f.handles.set(host.id, h); await h.cache.saveDraft("same_conversation", `draft_${i}`); records.push(host);
    }
    return records;
  }, keys);
  const stale = await context.newPage();
  try {
    await stale.goto(url + "e2e/fixtures/multiple-hosts.html"); await stale.waitForFunction(() => !!window.multipleHosts);
    await stale.evaluate(async (ids) => { const f = window.multipleHosts; for (const id of ids) f.handles.set(id, await f.registry.open(id)); }, records.map((r) => r.id));
    const failed = await page.evaluate(async (id) => {
      const f = window.multipleHosts; const host = await f.registry.beginRemoval(id); const calls: string[] = [];
      let error = ""; try { await f.registry.finishRemoval(id, host.registrationId, { shared: async (r) => { calls.push(`shared:${r.id}`); }, push: async (r) => { calls.push(`push:${r.id}`); throw new Error("push_cleanup_failed"); }, browser: async () => undefined, key: async (ref) => { calls.push(`key:${ref}`); } }); } catch (e) { error = (e as Error).message; }
      return { error, calls, records: await f.registry.list(), pending: await new f.ClientCache(host.databaseName).pendingReset() };
    }, records[0]!.id);
    expect(failed.error).toBe("push_cleanup_failed"); expect(failed.calls).toEqual([`shared:${records[0]!.id}`, `push:${records[0]!.id}`]); expect(failed.pending).toEqual({ keyRef: "device_0" });
    expect(failed.records.find((r) => r.id === records[0]!.id)?.state).toBe("removing");
    const writes = await stale.evaluate(async (ids) => {
      const f = window.multipleHosts, settled = await Promise.allSettled(ids.map((id) => f.handles.get(id)!.cache.saveDraft("same_conversation", "late_write")));
      return settled.map((r) => r.status === "fulfilled" ? "written" : (r.reason as Error).message);
    }, records.map((r) => r.id));
    expect(writes).toEqual(["local_reset_in_progress", "written"]);
    await page.reload(); await page.waitForFunction(() => !!window.multipleHosts);
    const success = await page.evaluate(async (old) => {
      const f = window.multipleHosts, calls: string[] = []; const backend = { shared: async (r: { id: string }) => { calls.push(`shared:${r.id}`); }, push: async (r: { id: string }) => { calls.push(`push:${r.id}`); }, browser: async () => { calls.push("browser"); }, key: async (ref: string) => { calls.push(`key:${ref}`); } };
      await f.registry.finishRemoval(old.id, old.registrationId, backend);
      const fresh = await f.registry.add({ deviceId: "replacement", name: "replacement", publicKey: "fixture", hubPublicKey: old.publicKey, routes: [] }, "replacement");
      await (await f.registry.open(fresh.id)).cache.saveDraft("same_conversation", "new_pairing");
      let error = ""; try { await f.registry.finishRemoval(old.id, old.registrationId, backend); } catch (e) { error = (e as Error).message; }
      return { calls, error, fresh, records: await f.registry.list(), oldDatabaseExists: (await indexedDB.databases()).some((db) => db.name === old.databaseName), nextDraft: await (await f.registry.open(fresh.id)).cache.draft("same_conversation") };
    }, records[0]!);
    expect(success.calls).toEqual([`push:${records[0]!.id}`, "browser", "key:device_0"]); expect(success.error).toBe("host_removal_changed");
    expect(success.fresh.databaseName).not.toBe(records[0]!.databaseName); expect(success.records).toHaveLength(2); expect(success.oldDatabaseExists).toBe(false); expect(success.nextDraft).toBe("new_pairing");
    expect(await stale.evaluate(async (id) => { try { await window.multipleHosts.handles.get(id)!.cache.saveDraft("same_conversation", "resurrect"); return "written"; } catch (e) { return (e as Error).message; } }, records[0]!.id)).toBe("local_cache_closed");
    expect(await page.evaluate(async (id) => (await window.multipleHosts.registry.open(id)).cache.draft("same_conversation"), records[1]!.id)).toBe("late_write");
  } finally { await stale.close(); }
});

test("two real Hubs stream and drain identical queue IDs independently; revoking or removing one preserves the other", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multiple-hubs-")); const hubs: HubServer[] = [];
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const sockets = new Map<string, number>(); page.on("websocket", (socket) => { const address = new URL(socket.url()); if (address.pathname === "/ws") sockets.set(address.port, (sockets.get(address.port) ?? 0) + 1); });
  try {
    for (const name of ["A", "B"]) {
      const hub = await HubServer.start({ stateDir: path.join(root, name), origins: [new URL(url).origin] }); hubs.push(hub);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同名助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_conversation','direct','同名对话','owner',1,'same_action')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_conversation','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_conversation','bot','alpha',0)");
      await hub.store.publishBotMessage("alpha", { id: "same_message", conversationId: "same_conversation", blocks: [{ type: "text", text: `${name} initial` }], status: "streaming" });
    }
    const records = [];
    for (const [i, hub] of hubs.entries()) {
      const paired = await pairFixtureHost(page, hub, `Host ${i}`);
      await hub.auth.approve(paired.code, "local-owner"); records.push(paired.host);
    }
    await page.evaluate(async (ids) => { for (const id of ids) { const h = await window.multipleHosts.registry.open(id); await h.cache.enqueue({ v: 1, type: "message.send", conversationId: "same_conversation", clientMsgId: "same_queued", text: `only_${id}`, attachments: [] }); } }, records.map((r) => r.id));
    await page.evaluate(() => Promise.all([window.multipleHosts.pool.start(), window.multipleHosts.pool.start()]));
    for (const r of records) {
      await expect.poll(() => page.evaluate((id) => window.multipleHosts.pool.connection(id)?.state.status, r.id)).toBe("online");
      await expect.poll(() => page.evaluate(async (id) => (await window.multipleHosts.inspect(id)).outbox.length, r.id)).toBe(0);
    }
    for (const [i, hub] of hubs.entries()) {
      expect(sockets.get(new URL(hub.url).port)).toBe(1);
      const sent = (await hub.store.snapshot("owner", "same_conversation")).messages.filter((m) => m.authorType === "user");
      expect(sent).toHaveLength(1); expect(sent[0]?.blocks).toEqual([{ type: "text", text: `only_${records[i]!.id}` }]);
    }
    for (let step = 1; step <= 4; step++) await Promise.all(hubs.map((hub, i) => hub.store.publishBotMessage("alpha", { id: "same_message", conversationId: "same_conversation", blocks: [{ type: "text", text: `${i} stream ${step}` }], status: step === 4 ? "complete" : "streaming" })));
    for (const [i, r] of records.entries()) await expect.poll(() => page.evaluate(async (id) => (await window.multipleHosts.inspect(id)).messages.find((m) => m.id === "same_message")?.blocks, r.id)).toEqual([{ type: "text", text: `${i} stream 4` }]);
    await hubs[0]!.auth.revoke(records[0]!.deviceId, "local-owner");
    await page.evaluate((id) => window.multipleHosts.pool.connection(id)!.resume(), records[0]!.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.pool.connection(id)?.state.error, records[0]!.id)).toContain("吊销");
    await page.evaluate(async (id) => { const c = window.multipleHosts.pool.connection(id)!; await c.send({ v: 1, type: "message.send", conversationId: "same_conversation", clientMsgId: "b_after_revoke", text: "B still works", attachments: [] }); }, records[1]!.id);
    await expect.poll(async () => (await hubs[1]!.store.snapshot("owner", "same_conversation")).messages.some((m) => m.clientMsgId === "b_after_revoke")).toBe(true);
    await page.reload(); await page.waitForFunction(() => !!window.multipleHosts);
    await page.evaluate(() => window.multipleHosts.pool.start());
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.pool.connection(id)?.state.status, records[1]!.id)).toBe("online");
    expect(await page.evaluate((id) => window.multipleHosts.pool.connection(id)?.isClosed, records[0]!.id)).toBe(true);
    const removed = await page.evaluate(async ({ a, b }) => {
      const f = window.multipleHosts, original = f.pool.connection(b)!;
      const unsubscribeView = f.pool.subscribe(() => undefined); unsubscribeView();
      const profile = await original.http<{ revision: number }>("/api/host-profile");
      await original.http("/api/host-profile", { method: "PATCH", body: JSON.stringify({ name: "B renamed", revision: profile.revision }) });
      await f.pool.refresh();
      const host = await f.registry.beginRemoval(a); await f.pool.refresh();
      await f.registry.finishRemoval(a, host.registrationId, { shared: async () => undefined, push: async () => undefined, browser: async () => undefined, key: async () => { throw new Error("unexpected_native_key"); } });
      await f.pool.refresh();
      await original.send({ v: 1, type: "message.send", conversationId: "same_conversation", clientMsgId: "b_after_remove", text: "B survives host removal", attachments: [] });
      return { sameConnection: original === f.pool.connection(b), connected: original.state.status, removedConnection: !!f.pool.connection(a), hosts: f.pool.state.hosts.map((h) => h.host.name) };
    }, { a: records[0]!.id, b: records[1]!.id });
    expect(removed).toEqual({ sameConnection: true, connected: "online", removedConnection: false, hosts: ["B renamed"] });
    await expect.poll(async () => (await hubs[1]!.store.snapshot("owner", "same_conversation")).messages.some((m) => m.clientMsgId === "b_after_remove")).toBe(true);
    expect(sockets.get(new URL(hubs[1]!.url).port)).toBe(2); // initial boot + explicit page reload only
    const evidence = { hubs: 2, identicalIds: ["bot", "conversation", "message", "clientMsgId"], queueDeliveriesPerHost: 1, independentStreamUpdates: 4, revokedHostPreservedAfterReload: true, survivingHostOnline: true, sameConnectionAfterRenameAndOtherHostRemoval: true, pageErrors: errors };
    expect(errors).toEqual([]); await info.attach("multiple-hubs-foundation", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  } finally { await page.close(); await Promise.all(hubs.map((h) => h.close())); await rm(root, { recursive: true, force: true }); }
});

test("a connection rejects another host's cache and cannot revive after closing during hydration", async ({ page }) => {
  const hubKey = key(); let probes = 0;
  await page.route(new URL("/health", url).href, async (route) => { probes++; await route.fulfill({ json: { ok: true, publicKey: hubKey } }); });
  const outcome = await page.evaluate(async ({ hubKey, url }) => {
    const f = window.multipleHosts;
    const identity = { deviceId: "device_a", name: "A", publicKey: "fixture", hubPublicKey: hubKey, routes: [{ name: "Direct" as const, url }] };
    const a = new f.ClientCache("lifecycle_a"), b = new f.ClientCache("lifecycle_b");
    await a.saveIdentity(identity); await b.saveIdentity({ ...identity, deviceId: "device_b" });
    const wrong = new f.HubConnection(identity, b); let mismatch = "";
    try { await wrong.start(); } catch (e) { mismatch = (e as Error).message; }
    let release!: () => void;
    const original = a.activeMessages.bind(a); let reads = 0;
    a.activeMessages = () => ++reads === 1 ? new Promise((resolve) => { release = () => resolve([]); }) : original();
    const connection = new f.HubConnection(identity, a), first = connection.start(); connection.close();
    // A new mount can legitimately start the same transport, but the old
    // hydration result must not start a second socket when it arrives late.
    await connection.start(); release(); await first;
    const state = connection.state.status; connection.close();
    return { mismatch, wrongClosed: wrong.isClosed, reads, state };
  }, { hubKey, url: new URL(url).origin });
  expect(outcome).toMatchObject({ mismatch: "host_cache_identity_mismatch", wrongClosed: true, reads: 2 }); expect(probes).toBe(1);
});

test('shared names retain the newest host revision and ignore an obsolete registration', async ({ page }) => {
  const result = await page.evaluate(async (publicKey) => {
    const f = window.multipleHosts;
    const host = await f.registry.add({ deviceId: 'profile_device', publicKey: 'fixture', name: 'controller', hubPublicKey: publicKey, routes: [] }, 'old local alias');
    await f.registry.cacheHostProfile(host.id, host.registrationId, { name: 'example-mac', revision: 2 });
    await f.registry.cacheHostProfile(host.id, host.registrationId, { name: 'old-system.local', revision: 1 });
    await f.registry.cacheHostProfile(host.id, 'removed-registration', { name: 'wrong registration', revision: 99 });
    const saved = (await f.registry.list()).find(h => h.id === host.id)!;
    return { name: saved.name, profile: saved.hostProfile };
  }, key());
  expect(result).toEqual({ name: 'example-mac', profile: { name: 'example-mac', revision: 2 } });
});
