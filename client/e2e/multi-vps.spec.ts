import { preparePairing } from "./fixtures/pairing-invite.js";
import { enterMobileChat } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings } from "./fixtures/settings.js";
import { test, expect, type Page } from "@playwright/test";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { connectionTiming } from "../src/connection-timing.js";

test.use({ serviceWorkers: "block" });
async function proxy(hub: HubServer) {
  let mode: "online" | "blackhole" | "ws-blackhole" = "online";
  const peers = new Set<{ client: net.Socket; upstream: net.Socket; websocket: boolean }>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(new URL(hub.url).port), "127.0.0.1"), peer = { client, upstream, websocket: false }; peers.add(peer);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => { upstream.destroy(); peers.delete(peer); }); upstream.on("close", () => client.destroy());
    client.once("data", (first) => { peer.websocket = first.toString().startsWith("GET /ws "); if (mode === "blackhole" || mode === "ws-blackhole" && peer.websocket) return; upstream.write(first); client.pipe(upstream); upstream.pipe(client); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return { url, mode(value: typeof mode) { mode = value; for (const p of peers) { if (value === "online") { p.client.destroy(); p.upstream.destroy(); } else if (value === "blackhole" || p.websocket) { p.client.unpipe(p.upstream); p.upstream.unpipe(p.client); } } }, async close() { for (const p of peers) { p.client.destroy(); p.upstream.destroy(); } await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
async function pair(page: Page, hub: HubServer, routes: { url: string; label: string }[]) {
  await page.goto(hub.url); await page.getByLabel("Hub 地址", { exact: true }).fill("");
  await page.getByText("连接选项与备用中转（可选）", { exact: true }).click();
  await page.getByRole("button", { name: "添加中转", exact: true }).click();
  for (const [i, route] of routes.entries()) {
    if (i) await page.getByRole("button", { name: "添加备用中转", exact: true }).click();
    await page.getByLabel(i ? `备用中转 ${i} 地址` : "中转地址", { exact: true }).fill(route.url); await page.getByLabel(`中转线路 ${i + 1} 名称`, { exact: true }).fill(route.label);
  }
  await preparePairing(page, hub, routes.map(route => ({ name: "VPS", ...route }))); await page.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}

test("three VPS routes fail over twice on desktop and phone, retain one turn, without bouncing back merely because an earlier route recovered", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-vps-ui-")), stateDir = path.join(root, "instance"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const relays = await Promise.all([proxy(hub), proxy(hub), proxy(hub)]), names = ["主 VPS · 东京", "备用 VPS · 香港", "备用 VPS · 新加坡"];
  const dc = await browser.newContext(), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const desktop = await dc.newPage(), phone = await pc.newPage();
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','主备线路测试',?)", [hashSecret(secret)]);
  let release: (() => void) | undefined, calls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
    calls++; await input.onEngineEvent?.({ type: "assistant_text", text: "同一轮回复正在生成。", delta: true }); await new Promise<void>((resolve) => { release = resolve; input.abortSignal?.addEventListener("abort", resolve, { once: true }); }); return { text: "连续切换两台 VPS 后，回复仍然完整。" };
  } } });
  try {
    const conversation = await hub.store.createConversation("owner", ["alpha"], "多 VPS 同步", "multi");
    for (const page of [desktop, phone]) {
      for (const [i, relay] of relays.entries()) await page.route(`${relay.url}/health`, async route => { if (i) await new Promise(resolve => setTimeout(resolve, i * 70)); await route.continue(); });
      await pair(page, hub, relays.map((r, i) => ({ url: r.url, label: names[i]! }))); await enterMobileChat(page, conversation.title); }
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("主备切换请继续同一轮任务"); await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const page of [desktop, phone]) await expect(page.getByText("同一轮回复正在生成。", { exact: true })).toBeVisible();
    const measurements: number[] = [];
    // VPS paths use the remote heartbeat policy, even through a loopback test
    // proxy. Only a loopback Direct route has the sub-three-second deadline.
    const timing = connectionTiming({ name: "VPS", url: relays[0]!.url }, false);
    const failoverDeadline = timing.staleMs + timing.heartbeatMs + 2000;
    for (const i of [0, 1]) {
      const started = Date.now(); relays[i]!.mode("ws-blackhole");
      for (const page of [desktop, phone]) await expect(page.locator(".connection-pill")).toContainText(names[i + 1]!, { timeout: failoverDeadline });
      measurements.push(Date.now() - started);
    }
    // Both previous routes continue returning a healthy /health. Their failed
    // WebSocket paths must stay in independent cooldowns, not overwrite each other.
    relays[0]!.mode("online"); relays[1]!.mode("online");
    await desktop.waitForTimeout(6500); for (const page of [desktop, phone]) await expect(page.locator(".connection-pill")).toContainText(names[2]!);
    await phone.screenshot({ path: info.outputPath("multi-vps-phone-fallback.png") }); release?.();
    for (const page of [desktop, phone]) { await expect(page.getByRole("region", { name: "运行回复", exact: true }).getByText("连续切换两台 VPS 后，回复仍然完整。", { exact: true })).toHaveCount(1); await expect(page.locator(".connection-pill")).toContainText(names[2]!, { timeout: 12000 }); }
    expect(calls).toBe(1); expect((await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "user")).toHaveLength(1);
    await info.attach("failover-ms", { body: JSON.stringify(measurements), contentType: "application/json" });
    await openSettings(desktop, "connection"); await desktop.locator(".routes-editor").scrollIntoViewIfNeeded(); await desktop.screenshot({ path: info.outputPath("multi-vps-desktop-settings.png") });
  } finally { release?.(); await dc.close(); await pc.close(); await gateway.disconnect(); await Promise.all(relays.map((r) => r.close())); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("pairs using a backup, persists route edits and refuses a different Hub on a higher-priority VPS", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vps-settings-ui-")), hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), other = await HubServer.start({ stateDir: path.join(root, "other"), origins: [hub.url] });
  const primary = await proxy(hub), backup = await proxy(hub);
  try {
    primary.mode("blackhole"); await pair(page, hub, [{ url: primary.url, label: "主 VPS" }, { url: backup.url, label: "备用 VPS" }]);
    await expect(page.locator(".connection-pill")).toContainText("备用 VPS");
    await openSettings(page, "connection");
    await page.getByRole("button", { name: "添加备用中转", exact: true }).click(); await page.getByLabel("备用中转 2 地址", { exact: true }).fill(other.url); await page.getByLabel("中转线路 3 名称", { exact: true }).fill("错误 Hub");
    await page.getByRole("button", { name: "上移中转 3", exact: true }).click(); await page.getByRole("button", { name: "上移中转 2", exact: true }).click();
    // A prior background sweep can still be waiting on the blackholed route;
    // allow it to drain and the next sweep to inspect the newly saved route.
    const healthDeadline = 2 * connectionTiming({ name: "VPS", url: primary.url }, false).probeMs + 3000;
    await page.getByRole("button", { name: "保存线路", exact: true }).click(); await expect(page.locator(".vps-route").first()).toContainText("主机身份不匹配", { timeout: healthDeadline });
    await expect(page.locator(".connection-pill")).toContainText("备用 VPS"); expect(await other.store.devices("owner")).toHaveLength(0);
    await page.getByLabel("中转地址", { exact: true }).fill("not-a-url"); await page.getByRole("button", { name: "保存线路", exact: true }).click(); await expect(page.getByText("请输入有效 Hub HTTPS 地址", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "移除中转 1", exact: true }).click(); await page.getByRole("button", { name: "上移中转 2", exact: true }).click();
    await page.getByLabel("备用中转 1 地址", { exact: true }).fill(backup.url); await page.getByRole("button", { name: "保存线路", exact: true }).click(); await expect(page.getByText("线路地址不能重复；局域网与 Tailscale 合计最多 4 条，中转最多 8 条。", { exact: true })).toBeVisible();
    await page.getByLabel("备用中转 1 地址", { exact: true }).fill(primary.url); await page.getByRole("button", { name: "保存线路", exact: true }).click(); await expect(page.getByText("线路已保存。将自动检测可用性，并在合适时机选择更稳定的线路。", { exact: true })).toBeVisible();
    await page.reload(); await expect(page.locator(".connection-pill.online")).toContainText("备用 VPS"); await openSettings(page, "connection");
    await expect(page.getByLabel("中转地址", { exact: true })).toHaveValue(backup.url); await expect(page.getByLabel("备用中转 1 地址", { exact: true })).toHaveValue(primary.url);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator(".routes-editor").scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("multi-vps-phone-settings.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); await primary.close(); await backup.close(); await hub.close(); await other.close(); await rm(root, { recursive: true, force: true }); }
});
