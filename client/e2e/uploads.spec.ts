import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { connectionTiming } from "../src/connection-timing.js";
import net from "node:net";
import { createServer, request as forward } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { uploadFile } from "../src/files.js";
import { HubHttpError } from "../src/http-error.js";

// Fault injection must intercept the page's requests rather than a service
// worker's inner fetch. Offline service-worker reload is covered in hub.spec.ts.
test.use({ serviceWorkers: "block" });

async function paired(page: Page, hub: HubServer, primary = hub.url, fallback = hub.url, vpsOnly = false) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','文件验收',?)", [hashSecret(randomBytes(32).toString("base64url"))]);
  const conversation = await hub.store.createConversation("owner", ["alpha"], "文件验收", "fixture");
  await page.goto(hub.url); await page.getByLabel("Hub 地址", { exact: true }).fill(vpsOnly ? "" : primary);
  if (vpsOnly || primary !== hub.url) { await page.getByText("连接选项与备用中转（可选）", { exact: true }).click(); await page.getByRole("button", { name: "添加中转", exact: true }).click(); }
  if (vpsOnly) { await page.getByLabel("中转地址", { exact: true }).fill(primary); await page.getByRole("button", { name: "添加备用中转", exact: true }).click(); await page.getByLabel("备用中转 1 地址", { exact: true }).fill(fallback); }
  else if (primary !== hub.url) await page.getByLabel("中转地址", { exact: false }).fill(fallback);
  await preparePairing(page, hub, vpsOnly ? [{ name: "VPS", url: primary }, { name: "VPS", url: fallback }] : [{ name: "Direct", url: primary }, ...(primary !== hub.url ? [{ name: "VPS" as const, url: fallback }] : [])]); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await enterMobileChat(page, conversation.title);
  return conversation;
}

for (const [name, viewport] of [["desktop", { width: 1360, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${name} shows the Hub limit and keeps an oversized draft without starting an upload`, async ({ page }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "upload-limit-ui-")), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), maxFileBytes: 1024 });
    let creates = 0; page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/uploads")) creates++; });
    try {
      await page.setViewportSize(viewport); const conversation = await paired(page, hub);
      const file = page.locator('input[type="file"][multiple]');
      await file.setInputFiles({ name: "too-large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1025) });
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("这段说明要保留");
      await expect(page.getByText("单个附件上限 1 KiB", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("too-large.bin 超过单个附件上限 1 KiB");
      expect(creates).toBe(0); expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("这段说明要保留");
      await expect(page.locator(".attachment-chips")).toContainText("too-large.bin");
      await page.getByRole("button", { name: "移除 too-large.bin", exact: true }).click();
      await file.setInputFiles({ name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(1025) });
      await expect(page.getByText("单个附件上限 1 KiB", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "移除 too-large.png", exact: true }).click();
      await file.setInputFiles({ name: "fits.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024) });
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".file-card")).toContainText("fits.bin"); expect(creates).toBe(1);
      const messages = (await hub.store.snapshot("owner", conversation.id)).messages;
      expect(messages).toHaveLength(1); expect(messages[0]!.blocks[0]).toEqual({ type: "text", text: "这段说明要保留" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("a raised Hub limit permits an actual 513 MiB upload through the production composer with intact bytes", async ({ page }, info) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "upload-raised-")), hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), maxFileBytes: 1024 ** 3 });
  try {
    const conversation = await paired(page, hub), filename = path.join(root, "513-MiB.bin"), size = 513 * 1024 ** 2;
    const file = await open(filename, "w"); try { await file.truncate(size); await file.write(Buffer.from("end"), 0, 3, size - 3); } finally { await file.close(); }
    const before = createHash("sha256"); for await (const chunk of createReadStream(filename)) before.update(chunk); const expected = before.digest("hex");
    await page.locator('input[type="file"][multiple]').setInputFiles(filename);
    await expect(page.getByText("单个附件上限 1 GiB", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".file-card")).toContainText("513-MiB.bin", { timeout: 150_000 });
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages; expect(messages).toHaveLength(1);
    const block = messages[0]!.blocks[0]; if (block?.type !== "file") throw new Error("missing_file");
    const stored = await hub.attachments.download({ userId: "owner" }, block.attachmentId), after = createHash("sha256");
    for await (const chunk of createReadStream(stored.path)) after.update(chunk);
    expect(stored.row.size).toBe(size); expect(after.digest("hex")).toBe(expected); expect(await hub.store.pendingForBot("alpha")).toHaveLength(1);
    await info.attach("configured-limit-upload", { body: JSON.stringify({ limit: hub.attachments.maxFileBytes, size, sha256: expected, messages: messages.length }), contentType: "application/json" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("120 MiB upload reconciles a lost chunk receipt and finishes on the backup VPS without resending stored chunks", async ({ page }, info) => {
  test.setTimeout(120_000);
  const started = performance.now(), timing: Record<string, number> = {};
  const mark = (name: string) => { timing[name] = Math.round(performance.now() - started); };
  const root = await mkdtemp(path.join(os.tmpdir(), "upload-browser-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  let online = true; const pairs: [net.Socket, net.Socket][] = [], sockets = new Set<net.Socket>();
  let release: () => void = () => undefined; const held = new Promise<void>((resolve) => { release = resolve; });
  const puts: { route: string; index: number }[] = []; let lostReceipt = false, baselineReady = false;
  // Real HTTP forwarding preserves each browser's binary request stream. A
  // browser route.fetch() replay can alter WebKit's Blob upload body.
  async function proxy(preferred: boolean) {
    let address = "";
    const server = createServer(async (request, response) => {
      if (preferred && !online) return;
      if (!preferred && !baselineReady && request.url === "/health") { response.writeHead(503).end(); return; }
      const match = request.method === "PUT" && request.url?.match(/^\/api\/uploads\/[^/]+\/(\d+)$/);
      const index = match ? Number(match[1]) : -1;
      if (index >= 0) puts.push({ route: address, index });
      if (!preferred && index === 2) await held;
      if (request.destroyed || response.destroyed) return;
      const upstream = forward(new URL(request.url!, hub.url), { method: request.method, headers: request.headers }, (receipt) => {
        if (preferred && index === 1 && receipt.statusCode === 200 && !lostReceipt) {
          receipt.resume(); receipt.on("end", () => {
            lostReceipt = true; online = false; mark("faultInjected");
            for (const [client, remote] of pairs) { client.unpipe(remote); remote.unpipe(client); }
            response.destroy();
          });
        } else {
          response.writeHead(receipt.statusCode!, receipt.headers); receipt.pipe(response);
        }
      });
      upstream.on("error", () => response.destroy()); request.on("aborted", () => upstream.destroy());
      response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
      request.pipe(upstream);
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("upgrade", (request, client, head) => {
      if (preferred && !online) return;
      const upstream = net.connect(Number(new URL(hub.url).port), "127.0.0.1");
      if (preferred) pairs.push([client as net.Socket, upstream]);
      client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
      upstream.on("connect", () => {
        const headers = request.rawHeaders.reduce((text, value, i) => text + value + (i % 2 ? "\r\n" : ": "), "");
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    return { server, url: address };
  }
  const first = await proxy(true), second = await proxy(false), primary = first.url, fallback = second.url;
  try {
    const conversation = await paired(page, hub, primary, fallback, true);
    await expect(page.locator(".connection-pill.online")).toHaveAttribute("title", primary);
    baselineReady = true; mark("paired");
    const filename = path.join(root, "120-MiB.bin"), data = Buffer.alloc(120 * 1024 * 1024, 0x71);
    const expectedHash = createHash("sha256").update(data).digest("hex"); await writeFile(filename, data);
    await page.locator('input[type="file"]').setInputFiles(filename); await page.getByRole("textbox", { name: "消息", exact: true }).fill("断点续传验收");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    mark("sent");
    const timingPolicy = connectionTiming({ name: "VPS", url: primary }, false);
    await expect.poll(() => lostReceipt, { timeout: 30_000 }).toBe(true); await expect(page.locator(".connection-pill.online")).toContainText("中转 2", { timeout: timingPolicy.staleMs + timingPolicy.heartbeatMs + 2000 });
    mark("fallbackReady");
    await expect.poll(() => puts.some((p) => p.route === fallback && p.index === 2)).toBe(true);
    mark("fallbackUploadResumed");
    online = true; for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); }
    // A healthy preferred route must not interrupt a file still in flight.
    await page.waitForTimeout(6500); await expect(page.locator(".connection-pill")).toContainText("中转 2"); release();
    mark("heldChunkReleased");
    await expect(page.locator(".file-card")).toContainText("120-MiB.bin", { timeout: 30_000 });
    mark("messageCommitted");
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "user"); expect(messages).toHaveLength(1);
    const block = messages[0]!.blocks.find((b) => b.type === "file"); expect(block?.type).toBe("file"); if (block?.type !== "file") throw new Error("missing_file");
    const stored = await hub.attachments.download({ userId: "owner" }, block.attachmentId), hash = createHash("sha256"); for await (const chunk of createReadStream(stored.path)) hash.update(chunk);
    expect(hash.digest("hex")).toBe(expectedHash); expect(stored.row.size).toBe(120 * 1024 * 1024);
    expect(puts.map((p) => p.index)).toEqual(Array.from({ length: 15 }, (_, index) => index));
    // Completion is not an instruction to bounce back during the stability dwell.
    await expect(page.locator(".connection-pill")).toContainText("中转 2");
    mark("fallbackStillReady");
    console.log("Upload recovery timing", JSON.stringify(timing));
    await info.attach("upload-recovery", { body: JSON.stringify({ bytes: stored.row.size, sha256: expectedHash, requests: puts, storedMessages: messages.length, timing }), contentType: "application/json" });
  } finally {
    release(); await page.close(); for (const socket of sockets) socket.destroy();
    for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); }
    await Promise.all([first, second].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("cancelled recovery stops sending, retains the selected file, and an explicit retry succeeds", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "upload-cancel-")); const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  let puts = 0;
  try {
    const conversation = await paired(page, hub);
    await page.route("**/api/uploads/*/0", async (route) => { puts++; await route.abort("internetdisconnected"); });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("这份附件要与说明一起发送");
    await page.locator('input[type="file"]').setInputFiles({ name: "cancel.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024, 7) });
    await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(page.getByText("连接中断，等待恢复…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消上传", exact: true }).click(); await expect(page.getByText("上传已取消，已完成的分块会保留。", { exact: true })).toBeVisible();
    const after = puts; await page.waitForTimeout(800); expect(puts).toBe(after); expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("这份附件要与说明一起发送");
    await expect(page.locator(".attachment-chips")).toContainText("cancel.bin"); await page.unroute("**/api/uploads/*/0");
    await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(page.locator(".file-card")).toContainText("cancel.bin");
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages; expect(messages).toHaveLength(1); expect(messages[0]!.blocks[0]).toEqual({ type: "text", text: "这份附件要与说明一起发送" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("permission and hash failures are terminal; closing an offline connection releases a waiting transfer", async () => {
  for (const code of ["device_revoked", "conversation_forbidden", "sha256_mismatch"]) {
    let requests = 0, released = 0;
    const connection = { state: { status: "online" as const, bots: [], outbox: 0 }, isClosed: false, subscribe: () => () => undefined, resume: () => undefined, beginFileTransfer: () => () => { released++; }, http: async <T>() => { requests++; throw new HubHttpError(code === "device_revoked" ? 401 : code === "sha256_mismatch" ? 422 : 403, code); return {} as T; } };
    await expect(uploadFile(connection, "conv", new File(["fixture"], "file.txt"), () => undefined)).rejects.toThrow(code); expect(requests).toBe(1); expect(released).toBe(1);
  }
  let listener: (() => void) | undefined, released = 0;
  const connection = { state: { status: "offline" as const, bots: [], outbox: 0 }, isClosed: false, subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; }, resume: () => undefined, beginFileTransfer: () => () => { released++; }, http: async <T>() => ({} as T) };
  const pending = uploadFile(connection, "conv", new File(["fixture"], "file.txt"), () => undefined); const rejected = expect(pending).rejects.toThrow("连接已关闭");
  await expect.poll(() => !!listener).toBe(true); connection.isClosed = true; listener?.(); await rejected; expect(released).toBe(1); expect(listener).toBeUndefined();
});
