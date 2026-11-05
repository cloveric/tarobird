import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, enterMobileChat } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { authDeniedProof } from "../../src/client-protocol/auth-status.js";
import { serverProof } from "../../src/hub/auth.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

test("revocation while offline is verified on reconnect and survives reload without sending the outbox", async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-offline-revoked-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const trustedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const trusted = await trustedContext.newPage(); let offline = true, sockets = 0;
  page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") sockets++; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','缓存助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "离线撤销验收", "create");
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "history", text: "已有记录仍可阅读", attachments: [] });
    await pair(page, hub); const device = ((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))[0]!;
    await pair(trusted, hub); await showDisconnectedBots(trusted); await enterMobileChat(trusted, conversation.title);
    await page.routeWebSocket("**/ws", (socket) => { if (!offline) socket.connectToServer(); });
    await page.reload(); await expect(page.locator(".connection-pill.online")).toHaveCount(0);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("离线队列不要发送");
    await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(page.getByText("等待发送", { exact: true })).toHaveCount(1);
    await hub.auth.revoke(device.id, "local-owner"); offline = false;
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toBeVisible({ timeout: 7000 });
    await expect(page.locator(".message-blocks").getByText("已有记录仍可阅读", { exact: true })).toBeVisible();
    await page.waitForFunction(async (databaseName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return await new Promise<boolean>((resolve, reject) => { const request = db.transaction("settings").objectStore("settings").get("revokedIdentity"); request.onsuccess = () => resolve(typeof request.result === "string"); request.onerror = reject; }); } finally { db.close(); }
    }, await singleHostCacheName(page));
    const before = sockets; await page.reload();
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toBeVisible();
    expect(sockets).toBe(before); await expect(page.getByText("等待发送", { exact: true })).toHaveCount(1);
    await waitForClientOnline(trusted);
    await trusted.getByRole("textbox", { name: "消息", exact: true }).fill("可信设备仍然可用");
    await trusted.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => JSON.stringify((await hub.store.snapshot("owner", conversation.id)).messages)).toContain("可信设备仍然可用");
    expect(JSON.stringify((await hub.store.snapshot("owner", conversation.id)).messages)).not.toContain("离线队列不要发送");
    await page.screenshot({ path: info.outputPath("offline-revoked-desktop.png") });
    await trusted.screenshot({ path: info.outputPath("trusted-phone.png") });
  } finally { await page.close(); await trustedContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const failure of ["forged-signature", "wrong-hub", "old-nonce", "other-device", "changed-code", "challenge-signature"] as const) test(`rejects ${failure} denial without poisoning a healthy device`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-denial-scope-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await pair(page, hub);
    // Keys belong solely to this temporary test Hub and never leave the fixture.
    // Valid signatures for the wrong scope must be refused too, not just random bytes.
    const key = createPrivateKey(JSON.parse(await readFile(path.join(root, "identity.json"), "utf8")).privateKey);
    const attacker = generateKeyPairSync("ed25519"); let injected = false;
    await page.routeWebSocket("**/ws", (socket) => {
      if (injected) { socket.connectToServer(); return; }
      socket.onMessage((message) => {
        const hello = JSON.parse(String(message)); if (hello.type !== "hello") return;
        injected = true;
        const deviceId = failure === "other-device" ? "another_device" : hello.deviceId;
        const clientNonce = failure === "old-nonce" ? "old_nonce_".repeat(4) : hello.nonce;
        const data = failure === "challenge-signature" ? serverProof(deviceId, "fixture-challenge", clientNonce) : Buffer.from(authDeniedProof(deviceId, clientNonce));
        socket.send(JSON.stringify({ v: 1, type: "auth.denied", code: failure === "changed-code" ? "untrusted_device" : "device_revoked", deviceId, clientNonce,
          publicKey: failure === "wrong-hub" ? attacker.publicKey.export({ type: "spki", format: "der" }).toString("base64") : hub.auth.publicKey,
          signature: sign(null, data, failure === "wrong-hub" || failure === "forged-signature" ? attacker.privateKey : key).toString("base64") }));
      });
    });
    await page.reload(); await expect.poll(() => injected).toBe(true);
    await expect(page.locator(".connection-pill.online")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toHaveCount(0);
    await page.reload(); await waitForClientOnline(page);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("never accepts ready or sends application frames before verifying the Hub challenge", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-handshake-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const sent: string[] = []; let closed = 0;
  try {
    await pair(page, hub);
    const user = await hub.store.user("owner");
    // /health still returns the real pinned public key. An untrusted relay skips
    // the signature challenge and tries to claim that authentication has finished.
    await page.routeWebSocket("**/ws", (socket) => {
      socket.onClose(() => { closed++; });
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message)); sent.push(frame.type);
        if (frame.type === "hello") {
          socket.send(JSON.stringify({ v: 1, type: "ready", user, sessionToken: "forged-token", expiresAt: Date.now() + 60_000, bots: [], conversations: [] }));
          socket.send(JSON.stringify({ v: 1, type: "sync.complete" }));
        }
      });
    });
    await page.reload();
    await expect.poll(() => closed, { timeout: 5000 }).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((type) => type === "hello")).toBe(true);
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ignores forged revocation and conversation changes before the signed handshake", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-forged-notice-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let injected = 0;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','可信助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "可信对话", "create");
    await pair(page, hub);
    await page.routeWebSocket("**/ws", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        if (JSON.parse(String(message)).type === "hello") {
          injected++;
          socket.send(JSON.stringify({ v: 1, type: "notice", code: "device_revoked" }));
          socket.send(JSON.stringify({ v: 1, type: "conversation.updated", conversation: { ...conversation, id: "forged-conversation", title: "伪造对话" } }));
          socket.send(JSON.stringify({ v: 1, type: "sync.complete" }));
        }
        server.send(message);
      });
    });
    await page.reload();
    await expect.poll(() => injected).toBe(1);
    await waitForClientOnline(page);
    const stored = await page.evaluate(async (databaseName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      const read = (store: string, key: string) => new Promise<unknown>((resolve, reject) => { const request = db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return { revoked: !!await read("settings", "revokedIdentity"), forged: !!await read("conversations", "forged-conversation") }; } finally { db.close(); }
    }, await singleHostCacheName(page));
    expect(stored).toEqual({ revoked: false, forged: false });
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a forged post-ready notice cannot persist revocation of a trusted device", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-post-ready-notice-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let injected = false, attempts = 0;
  try {
    await pair(page, hub);
    await page.routeWebSocket("**/ws", (socket) => {
      attempts++; const server = socket.connectToServer();
      server.onMessage((message) => {
        socket.send(message);
        if (!injected && JSON.parse(String(message)).type === "sync.complete") {
          injected = true; socket.send(JSON.stringify({ v: 1, type: "notice", code: "device_revoked" }));
        }
      });
    });
    await page.reload(); await expect.poll(() => injected).toBe(true);
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
    await waitForClientOnline(page);
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toHaveCount(0);
    await page.reload(); await waitForClientOnline(page);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a socket closed during ready cache writes cannot reactivate transport", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-ready-close-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let attempts = 0, notifications = 0, closeSocket: (() => void) | undefined;
  try {
    await pair(page, hub);
    await page.addInitScript(() => {
      const probe = { ready: false, closed: false, blocked: false, released: false, reactivated: 0 };
      (window as typeof window & { readyWriteProbe: typeof probe }).readyWriteProbe = probe;
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => { if (JSON.parse(String(event.data)).type === "ready") probe.ready = true; });
          this.addEventListener("close", () => { probe.closed = true; });
        }
      };
      const interval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (probe.closed && timeout === 350) probe.reactivated++;
        return interval(handler, timeout, ...args);
      }) as typeof window.setInterval;
      const add = IDBTransaction.prototype.addEventListener;
      IDBTransaction.prototype.addEventListener = function (type, listener, options) {
        if (probe.ready && type === "complete" && this.mode === "readwrite" && this.objectStoreNames.contains("conversations") && typeof listener === "function" && !probe.blocked) {
          return add.call(this, type, (event) => {
            probe.blocked = true; setTimeout(() => { listener.call(this, event); probe.released = true; }, 600);
          }, options);
        }
        return add.call(this, type, listener, options);
      };
    });
    await page.routeWebSocket("**/ws", (socket) => {
      attempts++; if (attempts > 1) return;
      const server = socket.connectToServer(); closeSocket = () => { socket.close({ code: 1011 }); server.close({ code: 1011 }); };
      server.onMessage((message) => {
        // Only deliver the handshake: follow-up application frames must not mask
        // transport reactivation while the ready cache transaction is delayed.
        if (["challenge", "ready"].includes(JSON.parse(String(message)).type)) socket.send(message);
      });
    });
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/notifications") notifications++; });
    await page.reload();
    await page.waitForFunction(() => (window as typeof window & { readyWriteProbe?: { blocked: boolean } }).readyWriteProbe?.blocked);
    expect(closeSocket).toBeDefined(); closeSocket!();
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as typeof window & { readyWriteProbe: { released: boolean; reactivated: number } }).readyWriteProbe)).toMatchObject({ released: true, reactivated: 0 });
    expect(notifications).toBe(0);
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("verified revocation survives reload without reconnecting or removing cached history", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-revoked-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let sockets = 0; page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") sockets++; });
  try {
    // Model slow local storage: the socket can close while received history and
    // its following authenticated revocation are still in the processing queue.
    await page.addInitScript(() => {
      const add = IDBTransaction.prototype.addEventListener;
      IDBTransaction.prototype.addEventListener = function (type, listener, options) {
        if (type === "complete" && this.objectStoreNames.contains("messages") && typeof listener === "function") {
          return add.call(this, type, (event) => { setTimeout(() => listener.call(this, event), 200); }, options);
        }
        return add.call(this, type, listener, options);
      };
    });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','缓存助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "授权验收", "create");
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "history", text: "撤销授权不会删除已有历史", attachments: [] });
    await pair(page, hub);
    const device = ((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))[0]!;
    await hub.auth.revoke(device.id, "local-owner");
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toBeVisible();
    await page.waitForFunction(async (databaseName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return await new Promise<boolean>((resolve, reject) => { const request = db.transaction("settings").objectStore("settings").get("revokedIdentity"); request.onsuccess = () => resolve(typeof request.result === "string"); request.onerror = reject; }); } finally { db.close(); }
    }, await singleHostCacheName(page));
    const before = sockets;
    await page.reload();
    await expect(page.getByText("此设备已被吊销，请重新配对", { exact: true })).toBeVisible();
    await expect(page.locator(".message-blocks").getByText("撤销授权不会删除已有历史", { exact: true })).toBeVisible();
    expect(sockets).toBe(before);
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
