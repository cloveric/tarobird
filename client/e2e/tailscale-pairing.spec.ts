import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { desktopTls } from "../../src/hub/desktop-tls.js";
import { parsePairingLink } from "../src/pairing-link.js";
import { createServer } from "./fixtures/vite.js";

declare global { interface Window { tailscaleFixture: { state: { calls: string[]; lanAddresses: string[]; fail: boolean; wrongHost: boolean; certificateAuthority: string; hold?: () => void }; render(): void; decode(): Promise<string>; setLocale(locale: "zh" | "en"): void } } }
let server: ViteDevServer, directory: string, certificateAuthority: string;
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tailscale-invite-"));
  ({ certificateAuthority } = await desktopTls(directory, ["100.101.102.103"]));
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
});
test.afterAll(async () => { await server?.close(); await rm(directory, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/tailscale-pairing.html");
  await page.waitForFunction(() => !!window.tailscaleFixture);
  await page.evaluate(ca => { window.tailscaleFixture.state.certificateAuthority = ca; window.tailscaleFixture.render(); }, certificateAuthority);
});

test("explicit Tailscale choice creates a decodable, scoped HTTPS invite and explains existing phone repair", async ({ page }, testInfo) => {
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual([]);
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await expect(page.getByLabel("连接地址", { exact: true })).toHaveValue("https://192.168.10.20:8788");
  await expect(page.getByRole("img", { name: "连接二维码", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tailscale 异地连接", exact: true }).click();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await expect(page.getByText(/手机已经配对过/)).toBeVisible();
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status", "network"]);
  await page.getByRole("button", { name: "生成 Tailscale 二维码", exact: true }).click();
  await expect(page.getByRole("img", { name: "连接二维码", exact: true })).toBeVisible();
  const payload = parsePairingLink(await page.evaluate(() => window.tailscaleFixture.decode()));
  expect(payload).toMatchObject({ kind: "connect", deployment: "computer", routes: [{ name: "Tailscale", url: "https://100.101.102.103:8788", certificateAuthority }] });
  expect(payload.kind === "connect" && payload.invite).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status", "network", "status", "tailscale"]);
  await page.locator(".pairing-network-choice").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("tailscale-invite.png"), animations: "disabled" });
  for (const width of [320, 390, 1360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("dialog")).toBeInViewport();
    await page.locator(".pair-qr").scrollIntoViewIfNeeded();
    await expect(page.locator(".pair-qr")).toBeInViewport();
    expect(await page.locator(".desktop-host-invite").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test("a later Wi-Fi candidate remains selectable without putting all interfaces in a legacy QR", async ({ page }) => {
  await page.evaluate(() => { window.tailscaleFixture.state.lanAddresses = ["192.168.50.2", "172.16.10.1", "172.16.11.1", "10.10.10.2", "192.168.10.20"]; });
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  const selector = page.getByRole("combobox", { name: /^选择电脑所在网络/ });
  await expect(selector.locator("option")).toHaveCount(5);
  await selector.selectOption({ label: "192.168.10.20" });
  await expect(page.getByLabel("连接地址", { exact: true })).toHaveValue("https://192.168.10.20:8788");
  await expect.poll(async () => parsePairingLink(await page.evaluate(() => window.tailscaleFixture.decode()))).toMatchObject({
    kind: "connect", routes: [{ name: "Direct", url: "https://192.168.10.20:8788", certificateAuthority }],
  });
  const payload = parsePairingLink(await page.evaluate(() => window.tailscaleFixture.decode()));
  expect(payload.kind === "connect" && payload.routes.length).toBe(1);
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status", "network"]);
});

test("missing VPN can retry, a refresh never leaves a stale QR, and a different host is never configured", async ({ page }) => {
  await page.getByRole("button", { name: "Tailscale 异地连接", exact: true }).click();
  await page.evaluate(() => { window.tailscaleFixture.state.fail = true; });
  await page.getByRole("button", { name: "生成 Tailscale 二维码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请确认电脑已安装并连接 Tailscale");
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await page.evaluate(() => { window.tailscaleFixture.state.fail = false; window.tailscaleFixture.state.hold = () => {}; });
  await page.getByRole("button", { name: "生成 Tailscale 二维码", exact: true }).click();
  await expect(page.getByRole("button", { name: "正在准备连接…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "同一 Wi-Fi", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.tailscaleFixture.state.calls.length)).toBe(4);
  await page.evaluate(() => { window.tailscaleFixture.state.hold?.(); window.tailscaleFixture.state.hold = undefined; });
  await expect(page.locator(".pair-qr")).toBeVisible();
  await page.evaluate(() => { window.tailscaleFixture.state.fail = true; });
  await page.getByRole("button", { name: "网络变了？重新准备线路", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible(); await expect(page.locator(".pair-qr")).toHaveCount(0);
  await page.evaluate(() => { window.tailscaleFixture.state.calls = []; window.tailscaleFixture.state.wrongHost = true; });
  await page.getByRole("button", { name: "生成 Tailscale 二维码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请先启动当前电脑上的主机");
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status"]);
});

test("the same pairing choices and failure guidance are translated", async ({ page }) => {
  await page.evaluate(() => { window.tailscaleFixture.setLocale("en"); window.tailscaleFixture.state.fail = true; });
  await page.getByRole("button", { name: "Remote access with Tailscale", exact: true }).click();
  await expect(page.getByText(/Already paired/)).toBeVisible();
  await page.getByRole("button", { name: "Generate Tailscale QR code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Make sure Tailscale is installed and connected");
});


test("a LAN invitation keeps the legacy signed directory compatible while preserving Tailscale", async ({ page }) => {
  await page.evaluate(() => (window.tailscaleFixture as any).renderNetwork("pairing"));
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.tailscaleFixture as any).networkCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window.tailscaleFixture as any).networkCalls[0].routes.map((r: any) => r.name))).toEqual(["Tailscale"]);
});

test("network LAN preparation preserves Tailscale without a destructive replacement choice", async ({ page }) => {
  await page.evaluate(() => (window.tailscaleFixture as any).renderNetwork());
  await expect(page.getByRole("button", { name: "准备局域网线路", exact: true })).toBeEnabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "准备局域网线路", exact: true }).click();
  await expect(page.getByText("本机线路已共享，可以继续确认加入。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window.tailscaleFixture as any).networkCalls)).toMatchObject([{ operation: "routes", routes: [{ name: "Tailscale", url: "https://100.101.102.103:8788" }] }]);
});

 test("a route publication acknowledged after the waiting notice clears that notice without a second request", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = window.tailscaleFixture as any; f.holdRoutes(); f.renderNetwork(); });
  await page.getByRole("button", { name: "Tailscale 异地连接", exact: true }).click();
  await page.getByRole("button", { name: "准备 Tailscale 线路", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.tailscaleFixture as any).networkCalls.length)).toBe(1);
  await page.clock.fastForward(21000);
  await expect(page.getByRole("alert")).toContainText("网络线路仍在同步");
  await expect(page.getByRole("button", { name: "重新准备线路", exact: true })).toBeDisabled();
  await page.evaluate(() => (window.tailscaleFixture as any).releaseRoutes());
  await expect(page.getByRole("status")).toHaveText("本机线路已共享，可以继续确认加入。");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window.tailscaleFixture as any).networkCalls.length)).toBe(1);
});

test("capability alone does not falsely confirm that a LAN address was shared", async ({ page }) => {
  await page.evaluate(() => { (window.tailscaleFixture.state as any).unpublished = true; (window.tailscaleFixture as any).renderNetwork(); });
  await page.getByRole("button", { name: "准备局域网线路", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("此地址尚未自动共享");
  await expect(page.getByText("本机线路已共享，可以继续确认加入。", { exact: true })).toHaveCount(0);
});

test("connection settings show listener state without QR or mutations and fit compact windows", async ({ page }, testInfo) => {
  await page.evaluate(() => (window.tailscaleFixture as any).renderSettings());
  await expect(page.getByRole("button", { name: "局域网 本机已就绪", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tailscale 未开启", exact: true })).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual([]);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.tailscaleFixture.state as any).reads)).toBe(2);
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual([]);
  await page.getByRole("button", { name: "Tailscale 未开启", exact: true }).click();
  await expect(page.getByRole("button", { name: "开启 Tailscale 访问", exact: true })).toBeVisible();
  await expect(page.getByText(/若旧线路已全部失效/)).not.toBeVisible();
  for (const width of [320, 390, 1360]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page.getByRole("button", { name: "开启 Tailscale 访问", exact: true })).toBeInViewport();
    expect(await page.locator(".local-connection-settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`local-connection-${width}.png`), animations: "disabled" });
  }
  await page.getByText("连接说明与排查", { exact: true }).click();
  await expect(page.getByText(/若旧线路已全部失效/)).toBeVisible();
  await page.evaluate(() => window.tailscaleFixture.setLocale("en"));
  await expect(page.getByRole("button", { name: "Enable Tailscale access", exact: true })).toBeVisible();
});

test("enabling access preserves LAN, waits for publication, and never creates a QR", async ({ page }) => {
  await page.evaluate(() => { const f = window.tailscaleFixture as any; f.renderSettings(); f.holdRoutes(); });
  await page.getByRole("button", { name: "Tailscale 未开启", exact: true }).click();
  await page.getByRole("button", { name: "开启 Tailscale 访问", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.tailscaleFixture as any).networkCalls.length)).toBe(1);
  await expect(page.getByRole("button", { name: "关闭本机对外连接", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "正在准备连接…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => (window.tailscaleFixture as any).releaseRoutes());
  await expect(page.getByRole("button", { name: "Tailscale 本机已就绪", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "局域网 本机已就绪", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status", "tailscale"]);
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新状态", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status", "tailscale"]);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("failed or mismatched status never reports ready and native identity is checked before enabling", async ({ page }) => {
  await page.evaluate(() => { const f = window.tailscaleFixture as any; f.state.statusWrongHost = true; f.renderSettings(); });
  await expect(page.getByRole("alert")).toHaveText("未能读取本机入口状态，请重试。");
  await expect(page.getByText("本机入口已就绪", { exact: true })).toHaveCount(0);
  await page.evaluate(() => { const s = window.tailscaleFixture.state as any; s.statusWrongHost = false; s.statusFail = true; });
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.evaluate(() => { const s = window.tailscaleFixture.state as any; s.statusFail = false; s.wrongHost = true; });
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.getByRole("button", { name: "Tailscale 未开启", exact: true }).click();
  await page.getByRole("button", { name: "开启 Tailscale 访问", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请先启动当前电脑上的主机");
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual(["status"]);
  expect(await page.evaluate(() => (window.tailscaleFixture as any).networkCalls)).toEqual([]);
});

test("disconnected Tailscale and older hosts do not imply a working remote connection", async ({ page }) => {
  await page.evaluate(() => { const f = window.tailscaleFixture as any; f.state.local.tailscale = { enabled: true, listening: false }; f.renderSettings(); });
  await page.getByRole("button", { name: "Tailscale 等待网络连接", exact: true }).click();
  await expect(page.getByText("本机入口已就绪", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新准备线路", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新状态", exact: true })).toBeVisible();
  await page.evaluate(() => { (window.tailscaleFixture.state as any).local.tailscale.listening = true; });
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tailscale 本机已就绪", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual([]);
  await page.evaluate(() => { const f = window.tailscaleFixture as any; f.state.legacy = true; f.renderSettings(); });
  await expect(page.getByRole("button", { name: "Tailscale 状态不可用", exact: true })).toBeVisible();
  await expect(page.getByText("本机入口已就绪", { exact: true })).toHaveCount(0);
});


test("host addresses include the port, stay discoverable on reopen, and copy with honest feedback", async ({ page }) => {
  await page.evaluate(() => {
    const f = window.tailscaleFixture as any;
    f.state.local.tailscale = { enabled: true, listening: true };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { f.copied = text; if (f.copyFail) throw Error("denied"); } } });
    f.renderSettings();
  });
  await expect(page.getByLabel("连接地址 1", { exact: true })).toHaveText("https://192.168.10.20:8788");
  await page.getByRole("button", { name: "Tailscale 本机已就绪", exact: true }).click();
  await expect(page.getByLabel("连接地址 1", { exact: true })).toHaveText("https://100.101.102.103:8788");
  await page.getByRole("button", { name: "复制主机地址 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制主机地址 1", exact: true })).toHaveText("已复制");
  expect(await page.evaluate(() => (window.tailscaleFixture as any).copied)).toBe("https://100.101.102.103:8788");
  await page.evaluate(() => { (window.tailscaleFixture as any).copyFail = true; });
  await page.getByRole("button", { name: "复制主机地址 1", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("复制失败，请选择地址手动复制。");
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("状态已刷新");
  await expect(page.getByRole("status")).toContainText("不代表其他设备已连接");
  await page.getByRole("button", { name: "关闭本机对外连接", exact: true }).click();
  await page.evaluate(() => (window.tailscaleFixture as any).renderSettings());
  await page.getByRole("button", { name: "Tailscale 本机已就绪", exact: true }).click();
  await expect(page.getByLabel("连接地址 1", { exact: true })).toHaveText("https://100.101.102.103:8788");
  await page.evaluate(() => { (window.tailscaleFixture.state as any).statusFail = true; });
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("未能读取本机入口状态，请重试。");
  await expect(page.getByLabel("连接地址 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("本机入口已就绪", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.tailscaleFixture.state.calls)).toEqual([]);
});
