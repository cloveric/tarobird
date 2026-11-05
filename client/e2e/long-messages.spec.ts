import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { GatewayChannel } from "../../src/gateway/channel.js";
import { GatewayTransport } from "../../src/gateway/transport.js";
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES } from "../../src/client-protocol/index.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect((page.viewportSize()?.width ?? 1360) <=760 ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
}
async function select(page: Page, title: string) {
  const menu = page.getByRole("button", { name: "打开会话列表", exact: true });
  if (await menu.isVisible()) await menu.click();
  if ((page.viewportSize()?.width ?? 1360) <=760) { await enterMobileChat(page, title); return; }
  await page.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) }).click();
}
async function cached(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const registry = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const hosts = await new Promise<{databaseName:string}[]>((resolve,reject)=>{ const r=registry.transaction("hosts").objectStore("hosts").getAll(); r.onsuccess=()=>resolve(r.result); r.onerror=reject; }); registry.close();
    if(hosts.length !== 1) throw new Error("fixture requires exactly one host cache");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(hosts[0]!.databaseName); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    try {
      const value = await new Promise<{ version: number; status: string; blocks: unknown[] } | undefined>((resolve, reject) => { const r = db.transaction("messages").objectStore("messages").get(id); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      if (!value) return null;
      const bytes = new TextEncoder().encode(JSON.stringify(value.blocks));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      return { version: value.version, status: value.status, bytes: bytes.length, hash };
    } finally { db.close(); }
  }, id);
}

test("desktop and phone retain one complete long card across a partial transfer, Hub restart, snapshot and forward", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "long-card-browser-"));
  const options = { stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") };
  let hub = await HubServer.start(options); const port = Number(new URL(hub.url).port), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','长文助手',?)", [hashSecret(secret)]);
  const source = await hub.store.createConversation("owner", ["alpha"], "完整长回答", "long");
  const target = await hub.store.createConversation("owner", ["alpha"], "转发存档", "archive");
  const channel = new GatewayChannel(new GatewayTransport({ url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: path.join(root, "instance") }));
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  let fault = false, partial = false, dropped = 0, maxFrameBytes = 0, maxDataBytes = 0, fragments = 0;
  // Forward exactly one physical fragment to this device, then interrupt the
  // real Hub. The phone uses an independent unmodified WebSocket connection.
  await desktop.routeWebSocket("**/ws", (socket) => {
    const upstream = socket.connectToServer();
    upstream.onMessage((message) => {
      const raw = String(message), value = JSON.parse(raw) as { type: string; data?: string };
      maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(raw));
      if (value.type === "frame.fragment") {
        fragments++; maxDataBytes = Math.max(maxDataBytes, value.data!.length);
        if (fault) { if (partial) { dropped++; return; } partial = true; }
      }
      socket.send(message);
    });
  });
  try {
    await channel.connect(); await pair(desktop, hub); await pair(phone, hub);
    await select(desktop, source.title); await select(phone, source.title);
    const card = (text: string, streaming: boolean) => ({ config: { streaming_mode: streaming }, header: { template: "blue", title: { tag: "plain_text", content: "长文验证报告" } }, elements: [{ tag: "markdown", content: text }] });
    const initial = await channel.send(source.id, { card: card("正在准备长文", true) });
    for (const page of [desktop, phone]) await expect(page.getByText("正在准备长文", { exact: true })).toBeVisible();
    const before = await cached(desktop, initial.messageId);
    const text = "## 完整正文\n\n" + "长文".repeat(180_000) + "\n\n| 项目 | 结果 |\n| --- | --- |\n| 内容校验 | 完整保留 |\n\n$$x^2+y^2=z^2$$\n\n独特结尾标记";
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_FRAME_BYTES);
    fault = true; const publication = channel.updateCard(initial.messageId, card(text, false)); void publication.catch(() => undefined);
    await expect.poll(() => partial && dropped > 0).toBe(true);
    expect(await cached(desktop, initial.messageId)).toEqual(before);
    await hub.close(); fault = false; hub = await HubServer.start({ ...options, port }); await publication;
    const final = await hub.store.messageForBot("alpha", initial.messageId);
    const body = JSON.stringify(final.blocks), expected = { version: final.version, status: "complete", bytes: Buffer.byteLength(body), hash: createHash("sha256").update(body).digest("hex") };
    for (const page of [desktop, phone]) await expect.poll(() => cached(page, initial.messageId), { timeout: 20_000 }).toEqual(expected);
    // Force the consistent-snapshot path instead of another ordinary journal replay.
    let snapshotMessages = 0; const snapshotFrames = hub.store.snapshotFrames.bind(hub.store);
    hub.store.snapshotFrames = async function* (...args) { for await (const frame of snapshotFrames(...args)) { if (frame.type === "snapshot.message") snapshotMessages++; yield frame; } };
    await phone.evaluate(async (id) => {
      const registry = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const hosts = await new Promise<{databaseName:string}[]>((resolve,reject)=>{ const r=registry.transaction("hosts").objectStore("hosts").getAll(); r.onsuccess=()=>resolve(r.result); r.onerror=reject; }); registry.close();
    if(hosts.length !== 1) throw new Error("fixture requires exactly one host cache");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(hosts[0]!.databaseName); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("cursors", "readwrite"); tx.objectStore("cursors").put(999999, id); tx.oncomplete = () => resolve(); tx.onerror = reject; }); } finally { db.close(); }
    }, source.id);
    await phone.reload(); await expect(mobileHome(phone)).toBeVisible();
    await expect.poll(() => phone.evaluate(async (id) => {
      const registry = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const hosts = await new Promise<{databaseName:string}[]>((resolve,reject)=>{ const r=registry.transaction("hosts").objectStore("hosts").getAll(); r.onsuccess=()=>resolve(r.result); r.onerror=reject; }); registry.close();
    if(hosts.length !== 1) throw new Error("fixture requires exactly one host cache");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(hosts[0]!.databaseName); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      try { return await new Promise<number>((resolve, reject) => { const r = db.transaction("cursors").objectStore("cursors").get(id); r.onsuccess = () => resolve(r.result); r.onerror = reject; }); } finally { db.close(); }
    }, source.id)).toBeLessThan(999999);
    expect(snapshotMessages).toBeGreaterThan(0);
    await expect.poll(() => cached(phone, initial.messageId)).toEqual(expected);
    for (const [page, name] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await select(page, source.title);
      await expect(page.locator(".markdown-pending")).toHaveCount(0, { timeout: 20_000 });
      await expect(page.locator(".message-body table")).toContainText("完整保留");
      await expect(page.locator(".message-body .katex")).toHaveCount(1);
      await page.getByText("独特结尾标记", { exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByText("独特结尾标记", { exact: true })).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`long-card-${name}.png`) });
    }
    await desktop.locator(`[data-message-id="${initial.messageId}"]`).getByRole("button", { name: "转发消息", exact: true }).click();
    const dialog = desktop.getByRole("dialog", { name: "转发消息", exact: true });
    await dialog.getByRole("button", { name: target.title, exact: true }).click(); await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", target.id)).messages.length).toBe(1);
    const forwarded = (await hub.store.snapshot("owner", target.id)).messages[0]!;
    expect(forwarded.forwardedFrom?.messageId).toBe(initial.messageId);
    expect(createHash("sha256").update(JSON.stringify(forwarded.blocks)).digest("hex")).toBe(expected.hash);
    await expect.poll(() => cached(phone, forwarded.id)).toEqual({ ...expected, version: forwarded.version });
    expect(fragments).toBeGreaterThan(1); expect(maxFrameBytes).toBeLessThanOrEqual(MAX_FRAME_BYTES); expect(maxDataBytes).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    await info.attach("long-card-delivery", { body: JSON.stringify({ logicalBytes: expected.bytes, fragments, maxFrameBytes, maxDataBytes, dropped, devices: 2, hash: expected.hash }), contentType: "application/json" });
  } finally { await desktopContext.close(); await phoneContext.close(); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
