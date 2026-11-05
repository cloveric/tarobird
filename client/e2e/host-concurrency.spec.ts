import { pairFixtureHost } from "./fixtures/pair-registered-host.js";
import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubError } from "../../src/hub/store.js";
import type { multipleHosts } from "./fixtures/multiple-hosts.js";
declare global { interface Window { multipleHosts: typeof multipleHosts } }

const key = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
let server: ViteDevServer, url: string;
let pageErrors: string[];
let expectedReviewed: string[] = [], reviewedHits = new Set<string>();
test.beforeEach(async ({ page }) => {
  pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
  // Opt-in reproduction uses the exact source sent for review in an isolated
  // Vite transform. It never rewrites the working tree or production bundle.
  const reviewed = process.env.TAROCUB_REPRO_HOST_REVIEW ? await readFile(process.env.TAROCUB_REPRO_HOST_REVIEW, "utf8") : undefined;
  if (process.env.TAROCUB_REPRO_HOST_REVIEW && !reviewed?.trim()) throw new Error("Reviewed source is empty");
  const sources = new Map<string, string>();
  reviewedHits = new Set();
  if (reviewed) for (const block of reviewed.split("\nFILE ").slice(1)) {
    const newline = block.indexOf("\n"); if (newline < 1 || !block.slice(newline + 1).trim()) throw new Error("Malformed reviewed FILE block"); sources.set(path.resolve("..", block.slice(0, newline)), block.slice(newline + 1).replace(/^\d+: /gm, ""));
  }
  expectedReviewed = [...sources.keys()];
  if (reviewed && !expectedReviewed.length) throw new Error("No reviewed FILE blocks found");
  server = await createServer({ plugins: reviewed ? [{ name: "reviewed-host-source", enforce: "pre", transform(_code, id) { const file = id.split("?")[0]!; if (sources.has(file)) reviewedHits.add(file); return sources.get(file); } }] : [], server: { port: 0, strictPort: false, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0]!;
  await page.goto(url + "e2e/fixtures/multiple-hosts.html"); await page.waitForFunction(() => !!window.multipleHosts);
  if (reviewed) await page.evaluate(() => { const proto = window.multipleHosts.ClientCache.prototype; if (!proto.close) proto.close = () => undefined; });
});
test.afterEach(async ({ page }) => { await page.close(); await server.close(); expect(pageErrors).toEqual([]); expect([...reviewedHits].sort()).toEqual(expectedReviewed.sort()); });

test("waiting for one host's native key confirmation does not block opening or editing another host", async ({ page }) => {
  const outcome = await page.evaluate(async (keys) => {
    const f = window.multipleHosts, records = [];
    for (const [i, hubPublicKey] of keys.entries()) records.push(await f.registry.add({ deviceId: `device_${i}`, keyRef: `device_${i}`, publicKey: "fixture", name: "test", hubPublicKey, routes: [] }, `Host ${i}`));
    const a = records[0]!, b = records[1]!; await f.registry.beginRemoval(a.id);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const removal = f.registry.finishRemoval(a.id, a.registrationId, { shared: async () => undefined, push: async () => undefined, browser: async () => undefined, key: async () => { entered(); await held; } });
    await ready;
    const other = (async () => { const handle = await f.registry.open(b.id); await handle.cache.saveDraft("same", "B still editable"); handle.cache.close(); await f.registry.rename(b.id, "B renamed"); return true; })();
    const unblocked = await Promise.race([other, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800))]);
    release(); await removal; await other;
    return { unblocked, records: await f.registry.list() };
  }, [key(), key()]);
  expect(outcome.unblocked).toBe(true); expect(outcome.records.map((r) => r.name)).toEqual(["B renamed"]);
});

test("one broken preparation cannot block another; recovery preserves newer routes and cancellation protects a replacement cache", async ({ page }) => {
  const outcome = await page.evaluate(async (keys) => {
    const f = window.multipleHosts, put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) { if (this.name === "settings" && args[1] === "identity") { this.transaction.abort(); throw new Error("interrupted_install"); } return put.apply(this, args); };
    try { for (const [i, hubPublicKey] of keys.entries()) await f.registry.add({ deviceId: `device_${i}`, keyRef: `device_${i}`, publicKey: "fixture", name: "test", hubPublicKey, routes: [] }, `Host ${i}`).catch(() => undefined); }
    finally { IDBObjectStore.prototype.put = put; }
    const records = await f.registry.list(), a = records.find((r) => r.name === "Host 0")!, b = records.find((r) => r.name === "Host 1")!;
    const ca = new f.ClientCache(a.databaseName), cb = new f.ClientCache(b.databaseName);
    await ca.saveIdentity({ deviceId: "replacement", keyRef: "replacement", publicKey: "fixture_new", name: "replacement", hubPublicKey: keys[1], routes: [] });
    await ca.saveDraft("private", "belongs to replacement");
    await cb.saveIdentity({ deviceId: b.deviceId, keyRef: b.keyRef, publicKey: "fixture", name: "test", hubPublicKey: b.publicKey, routes: [{ name: "VPS", url: "https://new-route.example.com" }] });
    let recoveryError = ""; const failures = await f.registry.recoverPreparations().catch((error: Error) => { recoveryError = error.message; return []; });
    let removalError = ""; const deletedKeys: string[] = [];
    try { await f.registry.beginRemoval(a.id); await f.registry.finishRemoval(a.id, a.registrationId, { shared: async () => undefined, push: async () => undefined, browser: async () => undefined, key: async (ref) => { deletedKeys.push(ref); } }); } catch (error) { removalError = (error as Error).message; }
    const result = { failures, recoveryError, removalError, deletedKeys, records: await f.registry.list(), replacement: await ca.identity(), draft: await ca.draft("private"), routes: (await cb.identity())!.routes };
    ca.close(); cb.close(); return result;
  }, [key(), key()]);
  expect(outcome.recoveryError).toBe(""); expect(outcome.failures).toHaveLength(1); expect(outcome.failures[0]?.error).toBe("host_cache_identity_mismatch");
  expect(outcome.removalError).toBe(""); expect(outcome.deletedKeys).toEqual(["device_0"]); expect(outcome.records).toHaveLength(1); expect(outcome.records[0]?.state).toBe("ready");
  expect(outcome.replacement?.deviceId).toBe("replacement"); expect(outcome.draft).toBe("belongs to replacement"); expect(outcome.routes).toEqual([{ name: "VPS", url: "https://new-route.example.com" }]);
});

test("legacy import reports a conflict instead of hiding old drafts behind a newer pairing", async ({ page }) => {
  const outcome = await page.evaluate(async (hubPublicKey) => {
    const f = window.multipleHosts;
    const host = await f.registry.add({ deviceId: "new", name: "new", publicKey: "fixture", hubPublicKey, routes: [] }, "new");
    await f.cache.saveIdentity({ deviceId: "old", name: "old", publicKey: "fixture", hubPublicKey, routes: [] }); await f.cache.saveDraft("old", "keep me");
    let error = ""; try { await f.registry.importLegacy("old"); } catch (e) { error = (e as Error).message; }
    return { error, current: (await f.registry.open(host.id)).identity.deviceId, draft: await f.cache.draft("old") };
  }, key());
  expect(outcome).toEqual({ error: "legacy_host_conflict", current: "new", draft: "keep me" });
});

test("removal recovers after the final registry commit fails without repeating native cleanup", async ({ page }) => {
  for (const legacy of [false, true]) {
  const result = await page.evaluate(async ({ hubPublicKey, legacy }) => {
    const f = window.multipleHosts, identity = { deviceId: `device_cleanup_${legacy}`, keyRef: `device_cleanup_${legacy}`, name: "cleanup", publicKey: "fixture", hubPublicKey, routes: [] };
    if (legacy) await f.cache.saveIdentity(identity);
    const host = legacy ? (await f.registry.importLegacy("cleanup"))! : await f.registry.add(identity, "cleanup");
    const calls: string[] = []; const backend = { shared: async () => { calls.push("shared"); }, push: async () => { calls.push("push"); }, browser: async () => { calls.push("browser"); }, key: async () => { calls.push("key"); } };
    await f.registry.beginRemoval(host.id);
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (value) { if (this.name === "hosts") { this.transaction.abort(); throw new Error("registry_commit_failed"); } return remove.call(this, value); };
    let error = ""; try { await f.registry.finishRemoval(host.id, host.registrationId, backend); } catch (e) { error = (e as Error).message; } finally { IDBObjectStore.prototype.delete = remove; }
    const pending = await f.registry.list(); await f.registry.beginRemoval(host.id); await f.registry.finishRemoval(host.id, host.registrationId, backend);
    return { error, calls, pending: pending.map((h) => h.state), after: await f.registry.list(), databaseExists: (await indexedDB.databases()).some((db) => db.name === host.databaseName), pendingReset: legacy ? await f.cache.pendingReset() : undefined };
  }, { hubPublicKey: key(), legacy });
  expect(result).toEqual({ error: "registry_commit_failed", calls: ["shared", "push", "browser", "key"], pending: ["removing"], after: [], databaseExists: legacy, pendingReset: undefined });
  }
});

test("website cleanup failure retains its host removal record and scopes while another host remains usable", async ({page}) => {
  const result=await page.evaluate(async keys => {
    const f=window.multipleHosts;
    const add=async (i:number) => f.registry.add({deviceId:`website_${i}`,keyRef:`website_${i}`,name:`Host ${i}`,publicKey:"fixture",hubPublicKey:keys[i]!,routes:[]},`Host ${i}`);
    const a=await add(0),b=await add(1),cache=new f.ClientCache(a.databaseName);
    const scope=JSON.stringify([a.publicKey,"owner","chat_A"]);
    await cache.saveWorkbench(scope,-1,{schema:1,revision:0,tabs:[],closed:[],visible:[],active:null,maximized:null,expanded:false,column:.5,row:.5});cache.close();
    const calls:string[]=[],seen:any[]=[];let fail=true;
    const backend={shared:async()=>{calls.push("shared");},push:async()=>{calls.push("push");},browser:async(host:any,scopes:any[])=>{calls.push("browser");seen.push({host:host.publicKey,scopes});if(fail)throw Error("website_cleanup_failed");},key:async()=>{calls.push("key");}};
    await f.registry.beginRemoval(a.id);
    let error="";try{await f.registry.finishRemoval(a.id,a.registrationId,backend);}catch(cause){error=(cause as Error).message;}
    const pending=await f.registry.list();
    await f.registry.rename(b.id,"Other host still works");
    fail=false;await f.registry.finishRemoval(a.id,a.registrationId,backend);
    return {error,calls,seen,pending:pending.map(host=>({id:host.id,state:host.state})),after:(await f.registry.list()).map(host=>host.name),a:a.id,scope:{host:a.publicKey,user:"owner",conversation:"chat_A"}};
  },[key(),key()]);
  expect(result.error).toBe("website_cleanup_failed");
  expect(result.pending).toContainEqual({id:result.a,state:"removing"});
  expect(result.calls).toEqual(["shared","push","browser","browser","key"]);
  expect(result.seen).toEqual([{host:result.scope.host,scopes:[result.scope]},{host:result.scope.host,scopes:[result.scope]}]);
  expect(result.after).toEqual(["Other host still works"]);
});

test("pool startup waits for a newer directory refresh that superseded its first read", async ({ page }) => {
  const outcome = await page.evaluate(async (hubPublicKey) => {
    const f = window.multipleHosts, host = await f.registry.add({ deviceId: "device_start", name: "start", publicKey: "fixture", hubPublicKey, routes: [] }, "start");
    const list = f.registry.list.bind(f.registry), open = f.registry.open.bind(f.registry);
    let releaseList!: () => void, releaseOpen!: () => void, enteredOpen!: () => void, enteredList!: () => void, calls = 0, resolved = false;
    const listHeld = new Promise<void>((resolve) => { releaseList = resolve; }), listReady = new Promise<void>((resolve) => { enteredList = resolve; });
    const openHeld = new Promise<void>((resolve) => { releaseOpen = resolve; }), openReady = new Promise<void>((resolve) => { enteredOpen = resolve; });
    f.registry.list = async () => { if (++calls === 1) { enteredList(); await listHeld; } return list(); };
    f.registry.open = async (id) => { enteredOpen(); await openHeld; return open(id); };
    const starting = f.pool.start().then(() => { resolved = true; }); await listReady;
    await f.registry.rename(host.id, "renamed during boot"); await openReady; releaseList();
    await new Promise<void>((resolve) => setTimeout(resolve, 50)); const premature = resolved;
    releaseOpen(); await starting;
    const result = { premature, created: !!f.pool.connection(host.id), name: f.pool.state.hosts[0]?.host.name }; f.pool.close(); return result;
  }, key());
  expect(outcome).toEqual({ premature: false, created: true, name: "renamed during boot" });
});

test("two cache handles stage snapshots independently and never roll back a newer commit", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = window.multipleHosts, a = new f.ClientCache("shared_snapshot"), b = new f.ClientCache("shared_snapshot");
    const conversation = { id: "same", type: "direct" as const, title: "same", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 };
    const message = { id: "same_message", conversationId: "same", authorId: "alpha", authorType: "bot" as const, blocks: [{ type: "text" as const, text: "old" }], status: "complete" as const, version: 1, createdAt: 1 };
    await a.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "snap_a", conversation, seq: 10, after: 0, readSeq: 0 });
    await a.acceptSnapshot({ v: 1, type: "snapshot.message", id: "snap_a", index: 0, message, contentSeq: 10, unreadSeq: 10 });
    await b.discardSnapshot();
    await b.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "snap_b", conversation, seq: 11, after: 0, readSeq: 0 });
    await b.acceptSnapshot({ v: 1, type: "snapshot.message", id: "snap_b", index: 0, message: { ...message, version: 2, blocks: [{ type: "text", text: "newer" }] }, contentSeq: 11, unreadSeq: 11 });
    await b.acceptSnapshot({ v: 1, type: "snapshot.end", id: "snap_b", count: 1 });
    const olderAccepted = await a.acceptSnapshot({ v: 1, type: "snapshot.end", id: "snap_a", count: 1 });
    const result = { olderAccepted, messages: await a.messages("same"), cursors: await b.cursors() }; a.close(); b.close(); return result;
  });
  expect(result.olderAccepted).toBe(true); expect(result.messages[0]).toMatchObject({ version: 2, blocks: [{ type: "text", text: "newer" }] }); expect(result.cursors).toEqual({ same: 11 });
});

test("an obsolete failed route probe cannot take a newer authenticated socket offline", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-stale-probe-"));
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] }); let release = () => {}; let oldStarted = false, probes = 0, sockets = 0;
  page.on("websocket", (ws) => { if (new URL(ws.url()).pathname === "/ws") sockets++; });
  try {
    const paired = await pairFixtureHost(page, hub, "probe"); await hub.auth.approve(paired.code, "local-owner");
    await page.route(hub.url + "/health", async (route) => {
      probes++; if (probes === 1) { oldStarted = true; await new Promise<void>((resolve) => { release = resolve; }); await route.abort().catch(() => undefined); }
      else await route.continue();
    });
    await page.evaluate(async (id) => {
      const f = window.multipleHosts, handle = await f.registry.open(id), connection = new f.HubConnection(handle.identity, handle.cache); f.connections.set(id, connection);
      Object.assign(window, { oldHostStart: connection.start() });
    }, paired.host.id);
    await expect.poll(() => oldStarted).toBe(true);
    await page.evaluate((id) => { const c = window.multipleHosts.connections.get(id)!; c.close(); return c.start(); }, paired.host.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    release();
    await page.evaluate(() => (window as unknown as { oldHostStart: Promise<void> }).oldHostStart);
    expect(await page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    expect(await page.evaluate((id) => window.multipleHosts.connections.get(id)!.http<{ preferences: unknown }>("/api/notifications").then(() => true), paired.host.id)).toBe(true);
    expect(sockets).toBe(1);
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("the pool retries transient cache hydration failure on resume without reloading the page", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-hydration-retry-")); const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    const paired = await pairFixtureHost(page, hub, "retry"); await hub.auth.approve(paired.code, "local-owner");
    const initial = await page.evaluate(async (id) => {
      const f = window.multipleHosts, original = f.ClientCache.prototype.activeMessages; let fail = true;
      f.ClientCache.prototype.activeMessages = function () { if (fail) { fail = false; return Promise.reject(new Error("transient_idb_failure")); } return original.call(this); };
      try { await f.pool.start(); const failure = f.pool.state.hosts.find((h) => h.host.id === id)?.error; f.pool.resume(); return failure; }
      finally { f.ClientCache.prototype.activeMessages = original; }
    }, paired.host.id);
    expect(initial).toBe("transient_idb_failure");
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.pool.connection(id)?.state.status, paired.host.id)).toBe("online");
    expect(await page.evaluate((id) => window.multipleHosts.pool.state.hosts.find((h) => h.host.id === id)?.error, paired.host.id)).toBeUndefined();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("planned token renewal keeps a healthy route and an in-flight HTTP response", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-renewal-"));
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const authenticate = hub.auth.authenticate.bind(hub.auth); let logins = 0;
  let release = () => {}, held = false;
  try {
    const paired = await pairFixtureHost(page, hub, "renewal"); await hub.auth.approve(paired.code, "local-owner");
    // The invitation issuer authenticates during pairing setup. Only count and
    // shorten the actual client session, after that fixture work is finished.
    hub.auth.authenticate = async (...args) => { const session = await authenticate(...args); if (++logins === 1) session.expiresAt = Date.now() + 31_000; return session; };
    await page.evaluate((id) => window.multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    await page.route(hub.url + "/api/notifications?held", async (route) => { const response = await route.fetch(); held = true; await new Promise<void>((resolve) => { release = resolve; }); await route.fulfill({ response }).catch(() => undefined); });
    await page.evaluate((id) => { const c = window.multipleHosts.connections.get(id)!; Object.assign(window, { renewalHttp: c.http("/api/notifications?held").then(() => "ok", (error: Error) => error.name) }); }, paired.host.id);
    await expect.poll(() => held).toBe(true); await expect.poll(() => logins).toBe(2);
    release();
    expect(await page.evaluate(() => (window as unknown as { renewalHttp: Promise<string> }).renewalHttp)).toBe("ok");
    expect(await page.evaluate((id) => window.multipleHosts.connections.get(id)!.state.routeHealth?.[0]?.status, paired.host.id)).toBe("reachable");
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("foreground resume preserves a healthy connection and does not cancel active HTTP", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-resume-")); const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  let sockets = 0, held = false, release = () => {};
  page.on("websocket", (ws) => { if (new URL(ws.url()).pathname === "/ws") sockets++; });
  try {
    const paired = await pairFixtureHost(page, hub, "resume"); await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate((id) => window.multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    await page.route(hub.url + "/api/notifications?held", async (route) => { const response = await route.fetch(); held = true; await new Promise<void>((resolve) => { release = resolve; }); await route.fulfill({ response }).catch(() => undefined); });
    await page.evaluate((id) => { const c = window.multipleHosts.connections.get(id)!; Object.assign(window, { resumeHttp: c.http("/api/notifications?held").then(() => "ok", (e: Error) => e.name) }); }, paired.host.id);
    await expect.poll(() => held).toBe(true);
    await page.evaluate((id) => window.multipleHosts.connections.get(id)!.resume(), paired.host.id);
    release(); expect(await page.evaluate(() => (window as unknown as { resumeHttp: Promise<string> }).resumeHttp)).toBe("ok");
    expect(sockets).toBe(1);
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("clock skew cannot create a one-second renewal loop, and online wakes a backed-off connection", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-skew-")); const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    const paired = await pairFixtureHost(page, hub, "skew"); await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(() => {
      const now = Date.now, schedule = window.setTimeout.bind(window), delays: number[] = [];
      Date.now = () => now() + 2 * 60 * 60_000;
      window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => { delays.push(delay ?? 0); return schedule(fn, delay, ...args); }) as typeof window.setTimeout;
      Object.assign(window, { renewalDelays: delays });
    });
    await page.evaluate((id) => window.multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    expect(await page.evaluate(() => (window as unknown as { renewalDelays: number[] }).renewalDelays.some((n) => n > 860_000 && n <= 870_000))).toBe(true);
    await page.evaluate((id) => { const c = window.multipleHosts.connections.get(id)!; Reflect.set(c, "retry", 6); (Reflect.get(c, "ws") as WebSocket).close(1000); }, paired.host.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("offline");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id), { timeout: 2000 }).toBe("online");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a delayed heartbeat tick after a busy UI preserves the healthy socket and its active HTTP response", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-busy-ui-"));
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  let sockets = 0, held = false, release = () => {};
  page.on("websocket", ws => { if (new URL(ws.url()).pathname === "/ws") sockets++; });
  try {
    const paired = await pairFixtureHost(page, hub, "busy UI");
    await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(() => {
      const schedule = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 350 && typeof handler === "function") Object.assign(window, { heartbeatTick: handler });
        return schedule(handler, delay, ...args);
      }) as typeof window.setInterval;
    });
    await page.evaluate(id => window.multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate(id => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    await page.route(hub.url + "/api/notifications?held", async route => {
      const response = await route.fetch(); held = true;
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.evaluate(id => {
      const connection = window.multipleHosts.connections.get(id)!;
      Object.assign(window, { busyHttp: connection.http("/api/notifications?held").then(() => "ok", (error: Error) => error.name) });
    }, paired.host.id);
    await expect.poll(() => held).toBe(true);
    const status = await page.evaluate(id => {
      // Run the overdue real heartbeat callback before queued socket events,
      // matching the event-loop ordering that previously caused false loss.
      const until = performance.now() + 1400;
      while (performance.now() < until) { /* deliberate main-thread stall */ }
      (window as unknown as { heartbeatTick: () => void }).heartbeatTick();
      return window.multipleHosts.connections.get(id)!.state.status;
    }, paired.host.id);
    expect(status).toBe("online");
    release();
    expect(await page.evaluate(() => (window as unknown as { busyHttp: Promise<string> }).busyHttp)).toBe("ok");
    expect(sockets).toBe(1);
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("an expired session renews and drains both queued messages without manual retry", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-expiry-")); const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Expiry", "expiry");
    const send = hub.store.sendMessage.bind(hub.store); let expired = false;
    hub.store.sendMessage = async (...args) => { if (!expired) { expired = true; throw new HubError("session_expired", 401); } return send(...args); };
    const paired = await pairFixtureHost(page, hub, "expiry"); await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate((id) => window.multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate((id) => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    await page.evaluate(async ({ id, conversationId }) => { const c = window.multipleHosts.connections.get(id)!; for (const i of [1, 2]) await c.send({ v: 1, type: "message.send", clientMsgId: `expiry_${i}`, conversationId, text: `message ${i}`, attachments: [] }); }, { id: paired.host.id, conversationId: conversation.id });
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.length).toBe(2);
    await expect.poll(() => page.evaluate(async (id) => (await window.multipleHosts.connections.get(id)!.cache.outbox()).length, paired.host.id)).toBe(0);
    expect((await hub.store.snapshot("owner", conversation.id)).messages.map((m) => m.blocks[0])).toEqual([{ type: "text", text: "message 1" }, { type: "text", text: "message 2" }]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("accepted notification writes update shared desktop policy despite stale or failed reads", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const connection = new window.multipleHosts.HubConnection({ deviceId: "policy_fixture", name: "test", publicKey: "fixture", routes: [] });
    const before = { preferences: { enabled: true, quietStart: "", quietEnd: "", timeZone: "UTC" }, mutedConversations: ["muted"], providers: { apns: false, fcm: false, webpush: false, unifiedpush: false } };
    connection.state = { ...connection.state, notifications: before };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    connection.http = async <T,>() => { await held; return before as T; };
    const oldRead = connection.refreshNotificationPreferences();
    const accepted = { ...before.preferences, enabled: false, quietStart: "22:00", quietEnd: "08:00" };
    const seen: boolean[] = []; connection.subscribe(() => seen.push(connection.state.notifications!.preferences.enabled));
    connection.acceptNotificationPreferences(accepted);
    release(); await oldRead;
    connection.http = async () => { throw new Error("fixture_read_failure"); };
    await connection.refreshNotificationPreferences().catch(() => undefined);
    const after = structuredClone(connection.state.notifications);
    connection.close(); const closed = connection.state.notifications;
    connection.acceptNotificationPreferences(before.preferences);
    return { after, seen, closedUnchanged: connection.state.notifications === closed };
  });
  expect(result.after).toMatchObject({ preferences: { enabled: false, quietStart: "22:00", quietEnd: "08:00" }, mutedConversations: ["muted"], providers: { fcm: false } });
  expect(result.seen.every(enabled => !enabled)).toBe(true);
  expect(result.closedUnchanged).toBe(true);
});


test("a relay survives a brief network pause but retires a genuinely silent socket", async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(path.join(os.tmpdir(), "host-relay-jitter-"));
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  let sockets = 0, silence = false;
  // After authentication, simulate complete incoming silence on this socket.
  await page.routeWebSocket(hub.url.replace("http", "ws") + "/ws", ws => {
    if (++sockets > 1) silence = false;
    const server = ws.connectToServer();
    server.onMessage(message => {
      if (silence) return;
      ws.send(message);
    });
  });
  await page.reload(); await page.waitForFunction(() => !!window.multipleHosts);
  try {
    const paired = await pairFixtureHost(page, hub, "relay jitter");
    await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(async id => {
      const f = window.multipleHosts, handle = await f.registry.open(id);
      handle.identity.routes = handle.identity.routes.map(route => ({...route,name:"VPS" as const}));
      f.handles.set(id,handle);
      await f.start(id);
    },paired.host.id);
    await expect.poll(() => page.evaluate(id => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    const initial = sockets; expect(initial).toBeGreaterThan(0); silence = true;
    await page.waitForTimeout(5000);
    expect(await page.evaluate(id => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
    expect(sockets).toBe(initial);
    await expect.poll(() => sockets,{timeout:22000}).toBeGreaterThan(initial);
    await expect.poll(() => page.evaluate(id => window.multipleHosts.connections.get(id)?.state.status, paired.host.id)).toBe("online");
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});
