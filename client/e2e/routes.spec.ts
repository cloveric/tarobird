import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { test, expect } from "@playwright/test";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

// Keep the delayed health probe in the page transport, not a worker's fetch.
test.use({ serviceWorkers: "block" });
for (const healthDelay of [0, 350]) {
test(`fails over from a blackholed loopback Direct route in under 3s, replays once and keeps a healthy fallback (direct health delay ${healthDelay}ms)`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routes-e2e-")); const stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const pairs: [net.Socket, net.Socket][] = []; let online = true;
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(new URL(hub.url).port), "127.0.0.1"); pairs.push([client, upstream]);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
    if (online) { client.pipe(upstream); upstream.pipe(client); }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)); const address = proxy.address() as net.AddressInfo; const primary = `http://127.0.0.1:${address.port}`;
  const secret = randomBytes(32).toString("base64url"); let gateway: GatewayChannel | undefined; let release: (() => void) | undefined; let turns = 0, delayedProbes = 0;
  try {
    // Controlled RTT keeps the starting path deterministic without fixed priority.
    await page.route(`${hub.url}/health`, async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
    if (healthDelay) await page.route(`${primary}/health`, async route => { delayedProbes++; await new Promise(resolve => setTimeout(resolve, healthDelay)); await route.continue(); });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','线路测试',?)", [hashSecret(secret)]);
    gateway = await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
      if (++turns > 1) return { text: "备用线路上的下一条消息也已收到。" };
      await input.onEngineEvent?.({ type: "assistant_text", text: "正在持续输出路线测试内容。", delta: true });
      await new Promise<void>((resolve) => { release = resolve; input.abortSignal?.addEventListener("abort", resolve, { once: true }); });
      await input.onEngineEvent?.({ type: "assistant_text", text: "切换后的最终内容。", delta: true }); return { text: "正在持续输出路线测试内容。切换后的最终内容。" };
    } } });
    await page.goto(hub.url); await page.getByLabel("Hub 地址", { exact: true }).fill(primary); await page.getByText("连接选项与备用中转（可选）", { exact: true }).click(); await page.getByRole("button", { name: "添加 VPS 中转地址", exact: true }).click(); await page.getByLabel("中转地址", { exact: false }).fill(hub.url);
    await preparePairing(page, hub, [{ name: "Direct", url: primary }, { name: "VPS", url: hub.url }]); await page.getByRole("button", { name: "配对此设备", exact: true }).click(); const code = await page.getByLabel("配对码", { exact: true }).innerText(); await hub.auth.approve(code, "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    // Begin the timed failure only after the intended baseline is authenticated.
    await expect(page.locator(".connection-pill.online")).toContainText("主机直连", { timeout: 15_000 });
    await clickAppAction(page, "新建对话", page.getByRole("button", { name: "新建对话", exact: true }).last()); await page.getByRole("dialog", { name: "新建对话", exact: true }).getByRole("checkbox", { name: /线路测试/ }).check(); await page.getByRole("button", { name: "创建对话", exact: true }).click();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("开始"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-scroll").getByText("正在持续输出路线测试内容。", { exact: true })).toBeVisible();
    const started = Date.now(); online = false; for (const [client, upstream] of pairs) { client.unpipe(upstream); upstream.unpipe(client); }
    await expect(page.locator(".connection-pill.online")).toContainText("中转", { timeout: 3000 }); const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000); await info.attach("failover-ms", { body: String(elapsed), contentType: "text/plain" });
    online = true; for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); }
    await page.waitForTimeout(3000); await expect(page.locator(".connection-pill.online")).toContainText("中转");
    release?.(); await expect(page.locator(".message-scroll").getByText("正在持续输出路线测试内容。切换后的最终内容。", { exact: true })).toHaveCount(1);
    await page.waitForTimeout(3000); await expect(page.locator(".connection-pill.online")).toContainText("中转");
    const conversation = (await hub.store.conversations("owner"))[0]!; const messages = (await hub.store.snapshot("owner", conversation.id)).messages;
    expect(messages.filter((m) => m.authorType === "user")).toHaveLength(1);
    // Verify a second authenticated round trip over the stable fallback.
    // A recovered route cannot force a switch during the five-minute dwell.
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("确认备用线路继续工作"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-scroll").getByText("备用线路上的下一条消息也已收到。", { exact: true })).toBeVisible();
    await expect(page.locator(".connection-pill.online")).toContainText("中转");
    expect(turns).toBe(2);
    if (healthDelay) expect(delayedProbes).toBeGreaterThanOrEqual(1);
  } finally { release?.(); await gateway?.disconnect(); pairs.forEach(([client, upstream]) => { client.destroy(); upstream.destroy(); }); await new Promise<void>((resolve) => proxy.close(() => resolve())); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
}
