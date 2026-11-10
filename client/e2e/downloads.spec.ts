import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, enterMobileChat } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import net from "node:net";
import { createServer, request as forward } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { CHUNK_BYTES } from "../../src/client-protocol/index.js";
import { downloadProxy } from "./fixtures/download-proxy.js";

async function pair(page: Page, hub: HubServer, primary: string, backup: string) {
  await page.goto(hub.url); await page.getByLabel("Hub 地址", { exact: true }).fill("");
  await page.getByText("连接选项与备用中转（可选）", { exact: true }).click();
  await page.getByRole("button", { name: "添加 VPS 中转地址", exact: true }).click();
  await page.getByLabel("中转地址", { exact: true }).fill(primary);
  await page.getByRole("button", { name: "添加备用 VPS 地址", exact: true }).click(); await page.getByLabel("备用中转 1 地址", { exact: true }).fill(backup);
  await preparePairing(page, hub, [{ name: "VPS", url: primary }, { name: "VPS", url: backup }]); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // The fixture enables the backup only after both clients establish this baseline.
  await expect(page.locator(".connection-pill")).toHaveAttribute("title", primary, { timeout: 20_000 });
}

test("120 MiB download resumes on backup; phone cancellation is independent and both exports match", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "download-browser-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "allow" });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const errors: string[] = [], sockets = new Set<net.Socket>(), primarySockets = new Set<net.Socket>();
  for (const page of [desktop, phone]) page.on("pageerror", (error) => errors.push(error.message));
  const requests: { route: string; range: string; device: string }[] = [], owners = new Map<string, string>();
  let online = true, backupPaused = true, injected = false, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let faultAt = 0, backupAt = 0;
  async function proxy(primary: boolean) {
    const server = createServer(async (request, response) => {
      if (primary ? !online : backupPaused) { response.destroy(); return; }
      const isFile = request.method === "GET" && request.url?.startsWith("/api/attachments/");
      const range = request.headers.range ?? "";
      if (isFile) {
        const session = await hub.auth.authorize(request.headers.authorization?.replace(/^Bearer /, ""));
        if (!owners.has(session.deviceId)) owners.set(session.deviceId, owners.size ? "phone" : "desktop");
        requests.push({ route: primary ? "primary" : "backup", range, device: owners.get(session.deviceId)! });
        if (!primary && range.startsWith(`bytes=${CHUNK_BYTES}-`)) { backupAt ||= performance.now(); await held; }
      }
      if (response.destroyed) return;
      const upstream = forward(new URL(request.url!, hub.url), { method: request.method, headers: request.headers }, (result) => {
        response.writeHead(result.statusCode!, result.headers);
        if (primary && isFile && range.startsWith(`bytes=${CHUNK_BYTES}-`) && !injected) {
          // Drop the second range after forwarding real bytes. The first range
          // has already arrived and must not be fetched again after failover.
          result.once("data", (chunk) => {
            response.write(chunk); injected = true; online = false; backupPaused = true; faultAt = performance.now();
            result.destroy(); upstream.destroy(); response.destroy();
            for (const socket of primarySockets) socket.destroy();
          });
        } else result.pipe(response);
        result.on("error", () => response.destroy());
      });
      upstream.on("error", () => response.destroy()); request.on("aborted", () => upstream.destroy());
      response.on("close", () => { if (!response.writableEnded) upstream.destroy(); }); request.pipe(upstream);
    });
    server.on("connection", (socket) => { sockets.add(socket); if (primary) primarySockets.add(socket); socket.on("close", () => { sockets.delete(socket); primarySockets.delete(socket); }); });
    server.on("upgrade", (request, client, head) => {
      if (primary ? !online : backupPaused) { client.destroy(); return; }
      const remote = net.connect(Number(new URL(hub.url).port), "127.0.0.1"); sockets.add(remote);
      client.on("error", () => remote.destroy()); remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy()); remote.on("close", () => { sockets.delete(remote); client.destroy(); });
      remote.on("connect", () => {
        const headers = request.rawHeaders.reduce((text, value, i) => text + value + (i % 2 ? "\r\n" : ": "), "");
        remote.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` };
  }
  const primary = await proxy(true), backup = await proxy(false);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('files','文件助手',?)", [hashSecret("fixture")]);
    const conversation = await hub.store.createConversation("owner", ["files"], "文件续传", "fixture");
    const bytes = Buffer.alloc(120 * 1024 ** 2); for (let offset = 0; offset < bytes.length; offset += 4096) bytes.writeUInt32LE(offset, offset);
    const sha256 = createHash("sha256").update(bytes).digest("hex"), name = "120-MiB.bin";
    const attachmentId = await hub.attachments.importForBot("files", { conversationId: conversation.id, name, size: bytes.length, mime: "application/octet-stream", sha256 }, bytes);
    await hub.store.publishBotMessage("files", { conversationId: conversation.id, blocks: [{ type: "text", text: "可以在任意设备下载，断线会自动续传。" }, { type: "file", attachmentId, name, size: bytes.length, mime: "application/octet-stream" }], status: "complete" });
    for (const page of [desktop, phone]) { await pair(page, hub, primary.url, backup.url); await enterMobileChat(page, conversation.title); await expect(page.locator(".file-card")).toContainText(name); }
    backupPaused = false;
    const save = (page: Page) => page.getByRole("button", { name: `另存为 ${name}`, exact: true });
    const desktopDownload = desktop.waitForEvent("download"); await save(desktop).click();
    await expect.poll(() => injected).toBe(true);
    await expect(phone.locator(".connection-pill")).not.toHaveClass(/\bonline\b/);
    await save(phone).click(); await expect(phone.locator(".file-card").getByRole("status")).toHaveText("连接中断，等待恢复…");
    backupPaused = false; await expect.poll(() => backupAt, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(desktop.locator(".connection-pill")).toContainText("中转 2");
    await expect(phone.locator(".connection-pill")).toContainText("中转 2");
    await expect.poll(() => requests.some((request) => request.device === "phone" && request.range.startsWith(`bytes=${CHUNK_BYTES}-`))).toBe(true);
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await expect(page.locator(".file-card").getByRole("status")).toHaveText(device === "desktop" ? "连接中断，等待恢复…" : "下载中 6%");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`download-${device}.png`) });
    }
    await phone.getByRole("button", { name: "取消下载", exact: true }).click(); await expect(phone.locator(".file-card").getByRole("status")).toHaveText("下载已取消，进度已暂存"); await expect(phone.getByRole("alert")).toHaveCount(0);
    await phone.setViewportSize({ width: 320, height: 780 });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: info.outputPath("download-phone-cancelled.png") });
    online = true; await desktop.waitForTimeout(6500);
    await expect(desktop.locator(".connection-pill")).toContainText("中转 2"); // No idle switchback during a download.
    release(); const desktopFile = await desktopDownload; expect(await desktopFile.failure()).toBeNull();
    expect(createHash("sha256").update(await readFile((await desktopFile.path())!)).digest("hex")).toBe(sha256);
    const desktopRanges = requests.filter((request) => request.device === "desktop").map((request) => request.range);
    expect(desktopRanges).toEqual([`bytes=0-${CHUNK_BYTES - 1}`, ...Array.from({ length: 15 }, (_, index) => { const start = Math.max(1, index) * CHUNK_BYTES; return `bytes=${start}-${start + CHUNK_BYTES - 1}`; })]);
    const phoneDownload = phone.waitForEvent("download"); await save(phone).click(); const phoneFile = await phoneDownload;
    expect(await phoneFile.failure()).toBeNull(); expect(createHash("sha256").update(await readFile((await phoneFile.path())!)).digest("hex")).toBe(sha256);
    await expect(desktop.locator(".connection-pill")).toContainText("中转 2");
    expect(errors).toEqual([]);
    const evidence = JSON.stringify({ bytes: bytes.length, sha256, requests, recoveryMs: Math.round(backupAt - faultAt), devices: 2, serviceWorkerControlled: true, phoneStartedOffline: true, phoneCancelAndRetry: true, completeFileHashesMatch: true }, null, 2);
    await writeFile(info.outputPath("download-recovery.json"), evidence);
    await info.attach("download-recovery", { body: evidence, contentType: "application/json" });
  } finally {
    release(); await desktopContext.close(); await phoneContext.close(); for (const socket of sockets) socket.destroy();
    await Promise.all([primary, backup].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const restart of ["desktop-reload", "phone-reopen", "two-tabs"] as const) test(`120 MiB ${restart} resumes the persisted prefix and exports the exact file`, async ({ browser }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "download-reopen-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext(restart === "phone-reopen" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
  let page = await context.newPage(), release!: () => void, resumed = false;
  const held = new Promise<void>((resolve) => { release = resolve; }), requests: { phase: string; range: string }[] = [], errors: string[] = [];
  const proxy = await downloadProxy(hub.url, async (range) => {
    requests.push({ phase: resumed ? "resumed" : "initial", range });
    if (!resumed && range.startsWith(`bytes=${CHUNK_BYTES}-`)) { await held; return false; }
    return true;
  });
  const journal = (page: Page) => page.evaluate(async () => {
    const checkpoints: { offset: number }[] = []; let chunks = 0;
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith("tarocub-")) continue;
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
      try {
        if (!db.objectStoreNames.contains("downloadMeta")) continue;
        const tx = db.transaction(["downloadMeta", "downloadChunks"]);
        const [meta, count] = await Promise.all([new Promise<{ offset: number }[]>((resolve) => { const r = tx.objectStore("downloadMeta").getAll(); r.onsuccess = () => resolve(r.result); }), new Promise<number>((resolve) => { const r = tx.objectStore("downloadChunks").count(); r.onsuccess = () => resolve(r.result); })]);
        checkpoints.push(...meta.map(({ offset }) => ({ offset }))); chunks += count;
      } finally { db.close(); }
    }
    return { checkpoints, chunks };
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('files','文件助手',?)", [hashSecret("fixture")]);
    const conversation = await hub.store.createConversation("owner", ["files"], "刷新后继续下载", "fixture");
    const bytes = Buffer.alloc(120 * 1024 ** 2); for (let offset = 0; offset < bytes.length; offset += 4096) bytes.writeUInt32LE(offset, offset);
    const sha256 = createHash("sha256").update(bytes).digest("hex"), name = "restart-120-MiB.bin";
    const attachmentId = await hub.attachments.importForBot("files", { conversationId: conversation.id, name, size: bytes.length, mime: "application/octet-stream", sha256 }, bytes);
    await hub.store.publishBotMessage("files", { conversationId: conversation.id, blocks: [{ type: "file", attachmentId, name, size: bytes.length, mime: "application/octet-stream" }], status: "complete" });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(hub.url); await page.getByLabel("Hub 地址", { exact: true }).fill(proxy.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await enterMobileChat(page, conversation.title);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const originalDownload = restart === "two-tabs" ? page.waitForEvent("download") : undefined;
    await page.getByRole("button", { name: `另存为 ${name}`, exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator(".file-card").getByRole("status")).toHaveText("下载中 6%");
    expect(await journal(page)).toEqual({ checkpoints: [{ offset: CHUNK_BYTES }], chunks: 1 });
    await page.screenshot({ path: info.outputPath(`${restart}-checkpoint.png`) });
    if (restart === "phone-reopen") { await page.close(); page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message)); await page.goto(hub.url); }
    else if (restart === "two-tabs") { page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message)); await page.goto(hub.url); }
    else await page.reload();
    if (restart !== "two-tabs") release();
    await waitForClientOnline(page); await enterMobileChat(page, conversation.title);
    expect(await journal(page)).toEqual({ checkpoints: [{ offset: CHUNK_BYTES }], chunks: 1 });
    resumed = true;
    const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: `另存为 ${name}`, exact: true }).click(); const file = await downloaded;
    expect(await file.failure()).toBeNull(); const saved = await readFile((await file.path())!);
    expect(saved.length).toBe(bytes.length); expect(createHash("sha256").update(saved).digest("hex")).toBe(sha256);
    const resumedRanges = requests.filter((r) => r.phase === "resumed").map((r) => r.range);
    expect(resumedRanges).toEqual(Array.from({ length: 14 }, (_, i) => `bytes=${(i + 1) * CHUNK_BYTES}-${(i + 2) * CHUNK_BYTES - 1}`));
    if (originalDownload) {
      release(); const original = await originalDownload; expect(await original.failure()).toBeNull();
      const firstSaved = await readFile((await original.path())!); expect(firstSaved.length).toBe(bytes.length);
      expect(createHash("sha256").update(firstSaved).digest("hex")).toBe(sha256);
      expect(requests.filter((r) => r.phase === "resumed").map((r) => r.range)).toEqual([...resumedRanges, ...resumedRanges]);
    }
    expect(await journal(page)).toEqual({ checkpoints: [], chunks: 0 }); expect(errors).toEqual([]);
    const evidence = JSON.stringify({ restart, bytes: bytes.length, sha256, retainedBytes: CHUNK_BYTES, resumedTransferredBytes: bytes.length - CHUNK_BYTES, requests, serviceWorkerControlled: true, finalHashMatches: true, concurrentDownloads: originalDownload ? 2 : 1, journalCleaned: true }, null, 2);
    await writeFile(info.outputPath(`${restart}.json`), evidence); await info.attach(restart, { body: evidence, contentType: "application/json" });
  } finally { release(); await context.close(); await proxy.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
