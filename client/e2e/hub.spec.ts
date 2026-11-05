import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openSettings } from "./fixtures/settings.js";
import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

test("pair, render a real streamed reply, use offline outbox, search and revoke", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-e2e-")); const stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const origins: string[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), origins });
  // WebKit's offline emulator may leave established WebSockets alive. Cut the
  // actual transport as well, while keeping the app's origin/cache unchanged.
  let networkOnline = true; const sockets = new Set<net.Socket>();
  const proxy = net.createServer((client) => {
    if (!networkOnline) { client.destroy(); return; }
    const upstream = net.connect(Number(new URL(hub.url).port), "127.0.0.1");
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("error", () => { client.destroy(); upstream.destroy(); }); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const clientUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`; origins.push(clientUrl);
  const secret = randomBytes(32).toString("base64url"); let gateway: GatewayChannel | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort) VALUES('alpha','研究助手',?,'codex','Example Model','high')", [hashSecret(secret)]);
    gateway = await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", model: "Example Model", effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
      const answer = `收到你的消息。\n\n**测试回答完成**\n\n| 项目 | 状态 |\n|---|---|\n| 实时连接 | 正常 |\n| 本地会话 | 已同步 |\n\n公式：$a^2+b^2=c^2$\n\n\`\`\`typescript\nconst message = "Hello TaroCub";\n\`\`\``;
      await input.onEngineEvent?.({ type: "thinking", text: "正在检查连接和会话状态。" });
      for (let i = 0; i < answer.length; i += 24) { await input.onEngineEvent?.({ type: "assistant_text", text: answer.slice(i, i + 24), delta: true }); await new Promise((r) => setTimeout(r, 15)); }
      return { text: answer };
    } } });
    await page.goto(clientUrl);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const code = await page.getByLabel("配对码", { exact: true }).innerText(); await hub.auth.approve(code, "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    await clickAppAction(page, "新建对话", page.getByRole("button", { name: "新建对话", exact: true }).last());
    await page.getByPlaceholder("为这段对话起个名字").fill("产品设计讨论");
    await page.getByRole("dialog").getByRole("checkbox").check(); await page.getByRole("button", { name: "创建对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "产品设计讨论" })).toBeVisible();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("你好，测试一下连接"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("测试回答完成", { exact: true })).toBeVisible();
    await expect(page.locator(".markdown table")).toBeVisible(); await expect(page.locator(".katex").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("desktop-light.png"), fullPage: true });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    networkOnline = false; for (const socket of sockets) socket.destroy(); await expect(page.locator(".connection-pill.offline")).toBeVisible();
    for (const text of ["离线消息一", "离线消息二", "离线消息三"]) { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); }
    await expect(page.getByText("等待发送", { exact: true })).toHaveCount(3);
    await page.reload(); await expect(page.getByText("等待发送", { exact: true })).toHaveCount(3); await expect(page.getByText("测试回答完成", { exact: true })).toBeVisible();
    // A fresh offline page must start the cached parser worker, not merely show
    // plain-text fallback or keep the previous page's rendered DOM alive.
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(page.locator(".katex").first()).toBeVisible();
    await expect(page.locator(".markdown code .hljs-keyword").first()).toHaveText("const");
    networkOnline = true; await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible({ timeout: 20_000 }); await expect(page.getByText("等待发送", { exact: true })).toHaveCount(0, { timeout: 20_000 });
    const conversation = (await hub.store.conversations("owner"))[0]!; const messages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "user");
    expect(messages).toHaveLength(4); expect(messages.slice(1).map((m) => m.blocks[0]?.type === "text" ? m.blocks[0].text : "")).toEqual(["离线消息一", "离线消息二", "离线消息三"]);
    await page.getByRole("textbox", { name: "搜索历史消息" }).fill("离线消息二"); await page.getByRole("textbox", { name: "搜索历史消息" }).press("Enter"); await expect(page.getByRole("heading", { name: "搜索结果 · 1" })).toBeVisible();
    await page.getByRole("button", { name: "关闭搜索" }).click();
    await openSettings(page, "general"); await page.getByLabel("主题", { exact: true }).selectOption("dark"); await page.getByRole("button", { name: "关闭设置" }).click();
    await page.screenshot({ path: info.outputPath("desktop-dark.png"), fullPage: true });
    await openSettings(page, "general"); await page.getByLabel("语言", { exact: true }).selectOption("en"); await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Close settings" }).click(); await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible(); await expect(page.getByText("测试回答完成", { exact: true }).first()).toBeVisible();
    await page.reload(); await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Settings", exact: true }).click(); await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en"); await page.getByLabel("Language", { exact: true }).selectOption("zh"); await page.getByRole("button", { name: "关闭设置" }).click();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".sidebar")).not.toBeInViewport(); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeInViewport(); await page.screenshot({ path: info.outputPath("mobile-dark.png"), fullPage: true });
    const devices = (await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"); await hub.auth.revoke(devices[0]!.id, "local-owner"); await expect(page.getByText("此设备已被吊销，请重新配对")).toBeVisible();
    await page.setViewportSize({ width: 1360, height: 900 }); await openSettings(page, "general"); await page.getByRole("button", { name: "关闭设置", exact: true }).click(); await clickAppAction(page, "设备与网络"); await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
    await page.getByRole("dialog", {name:"此设备的连接",exact:true}).getByRole("button", {name:"从此设备移除",exact:true}).click();
    const removal = page.getByRole("dialog", {name:`从此设备移除「${(await hub.profile.read()).name}」？`,exact:true});
    await removal.getByRole("checkbox").check(); await removal.getByRole("button", {name:"确认移除",exact:true}).click(); await expect(page.getByRole("heading", { name: "连接你的 TaroBird" })).toBeVisible();
    const remaining = await page.evaluate(async () => { const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open("tarocub-v1"); req.onsuccess = () => resolve(req.result); req.onerror = reject; }); const counts = await Promise.all(["conversations", "messages", "outbox", "cursors"].map((name) => new Promise<number>((resolve) => { const request = db.transaction(name).objectStore(name).count(); request.onsuccess = () => resolve(request.result); }))); db.close(); return counts; }); expect(remaining).toEqual([0, 0, 0, 0]);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
