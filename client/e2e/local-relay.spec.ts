import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/local-relay.html"); });
test("local Connection page exposes VPS setup without another device", async ({ page }) => {
  await expect(page.getByRole("button", { name: "添加 VPS 中转", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑线路", exact: true })).toHaveCount(0);
});
async function enter(page: Page) {
  await page.getByRole("button", { name: "添加 VPS 中转", exact: true }).click();
  await page.getByLabel("中转地址", { exact: true }).fill("https://relay.example.com:8445");
}
const save = (page: Page) => page.getByRole("button", { name: "验证并保存中转", exact: true }).click();
for (const platform of ["windows", "macos"]) test(`${platform} saves on the host, preserves loopback and Tailscale, and reads saved endpoints on reopen`, async ({ page }, info) => {
  await page.evaluate(platform => { Object.defineProperty(navigator, "userAgent", { value: platform === "windows" ? "Windows NT 10.0" : "Macintosh" }); }, platform);
  await enter(page); await save(page);
  await expect(page.getByRole("status")).toContainText("中转入口已保存");
  expect(await page.evaluate(() => { const f = (window as any).localRelayFixture; return { writes: f.state.writes, updates: f.state.updates, routes: f.connection.identity.routes, native: f.state.native }; })).toEqual({
    writes: [{ operation: "routes", networkId: "", routes: [{ name: "Tailscale", url: "https://100.101.102.103:8788" }, { name: "VPS", url: "https://relay.example.com:8445" }] }], updates: 0, routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }], native: ["status"],
  });
  await page.getByRole("button", { name: "关闭连接状态与线路", exact: true }).click();
  await page.evaluate(() => (window as any).localRelayFixture.render());
  await expect(page.getByText("https://relay.example.com:8445", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "连接码", exact: true }).click();
  await expect(page.getByRole("img", { name: "连接二维码", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收起连接码", exact: true }).click();
  expect(await page.locator(".local-relay-settings .saved-routes li>div").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(250);
  await page.locator(".settings-content").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath(`${platform}-local-relay.png`), animations: "disabled" });
});
for (const mode of ["wrongHost", "offlineRelay"] as const) test(`${mode} cannot publish or overwrite the existing route`, async ({ page }) => {
  await enter(page);
  await page.evaluate(mode => { (window as any).localRelayFixture.state[mode] = true; }, mode);
  await save(page);
  await expect(page.getByRole("alert")).toContainText(mode === "wrongHost" ? "属于另一台主机" : "暂时无法验证");
  await expect(page.getByLabel("中转地址", { exact: true })).toHaveValue("https://relay.example.com:8445");
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes)).toEqual([]);
});
test("saving waits for one receipt and blocks closing or LAN setup until it arrives", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { (window as any).localRelayFixture.state.hold = true; });
  await save(page);
  await expect.poll(() => page.evaluate(() => (window as any).localRelayFixture.state.writes.length)).toBe(1);
  await expect(page.getByRole("button", { name: "关闭连接状态与线路", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "局域网与 Tailscale", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "连接状态与线路", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "正在验证并保存…", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await page.evaluate(() => { const f = (window as any).localRelayFixture; f.state.failRead = true; f.state.release(); });
  await expect(page.getByRole("status")).toContainText("中转入口已保存");
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes.length)).toBe(1);
});
test("unsaved relay settings are protected by the Connection page discard dialog", async ({ page }) => {
  await enter(page); await page.getByRole("button", { name: "关闭连接状态与线路", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("中转地址", { exact: true })).toHaveValue("https://relay.example.com:8445");
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes)).toEqual([]);
});
test("another window's relay edit is not overwritten, while a fresh direct route is preserved", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { const f = (window as any).localRelayFixture; f.connection.state = { ...f.connection.state, network: { ...f.connection.state.network, host: { ...f.connection.state.network.host, routes: [{ name: "VPS", url: "https://changed.example.com" }] } } }; f.notify(); });
  await save(page); await expect(page.getByRole("alert")).toContainText("已在其他窗口更改");
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes)).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "管理 VPS 中转", exact: true }).click();
  await page.getByLabel("中转线路 1 名称", { exact: true }).fill("Updated");
  await page.evaluate(() => { const f = (window as any).localRelayFixture; const v = f.connection.state.network; f.connection.state = { ...f.connection.state, network: { ...v, host: { ...v.host, routes: [{ name: "Direct", url: "https://192.168.1.44:8788" }, ...v.host.routes] } } }; f.notify(); });
  await save(page); await expect(page.getByRole("status")).toContainText("中转入口已保存");
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes[0].routes)).toEqual([{ name: "Direct", url: "https://192.168.1.44:8788" }, { name: "VPS", url: "https://changed.example.com", label: "Updated" }]);
});
test("deleting the last relay does not probe it or remove the direct route", async ({ page }) => {
  await enter(page); await save(page);
  await page.getByRole("button", { name: "管理 VPS 中转", exact: true }).click();
  await page.getByRole("button", { name: "移除中转 1", exact: true }).click(); await save(page);
  await expect(page.getByRole("button", { name: "添加 VPS 中转", exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const f = (window as any).localRelayFixture; return { routes: f.state.writes[1].routes, probes: f.state.health.length, updates: f.state.updates }; })).toEqual({ routes: [{ name: "Tailscale", url: "https://100.101.102.103:8788" }], probes: 1, updates: 0 });
});
test("read failures retry and unsupported or offline hosts do not expose a live editor", async ({ page }) => {
  await page.getByRole("button", { name: "关闭连接状态与线路", exact: true }).click();
  await page.evaluate(() => { const f = (window as any).localRelayFixture; f.state.failRead = true; f.render(); });
  await expect(page.getByRole("alert")).toContainText("未能读取本机中转配置");
  await page.evaluate(() => { (window as any).localRelayFixture.state.failRead = false; });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("button", { name: "添加 VPS 中转", exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).localRelayFixture; f.connection.state = { ...f.connection.state, status: "offline" }; f.notify(); });
  await expect(page.getByRole("button", { name: "添加 VPS 中转", exact: true })).toHaveCount(0);
});
test("compact width and English labels retain reachable inputs and actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await enter(page);
  await page.evaluate(() => (window as any).localRelayFixture.setLocale("en"));
  await expect(page.getByRole("button", { name: "Verify and save relays", exact: true })).toBeEnabled();
  expect(await page.getByRole("dialog", { name: "Connection status & routes", exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

for (const width of [390, 1360]) test(`the connection page opens access settings without a return focus ring at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await page.getByRole("button", { name: "局域网与 Tailscale", exact: true }).click();
  await expect(page.locator(".local-connection-settings")).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.native)).toEqual(["status"]);
  await page.getByRole("button", { name: "关闭本机对外连接", exact: true }).click();
  await expect(page.locator(".local-connection-settings")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "局域网与 Tailscale", exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
  await page.screenshot({ path: info.outputPath('connection-after-child-close.png'), animations: 'disabled' });
  await expect(dialog).toHaveCSS("outline-style", "none");
  // Some WebViews restore focus to the modal container itself. It is not a
  // control and should never acquire a frame; its controls retain Tab feedback.
  await dialog.focus();
  await expect(dialog).toHaveCSS("outline-style", "none");
  const close = dialog.getByRole('button', { name: '关闭连接状态与线路', exact: true });
  await page.keyboard.press('Tab'); await close.focus();
  await expect(close).toHaveCSS('outline-style', 'solid');
});
test("reconnect does not replace the edit baseline and silently overwrite changed relay settings", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { const f = (window as any).localRelayFixture; f.connection.state = { ...f.connection.state, status: "offline" }; f.notify(); });
  await expect(page.getByText("请等待本机连接恢复后设置中转。", { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).localRelayFixture; const v = f.connection.state.network; f.connection.state = { ...f.connection.state, status: "online", network: { ...v, host: { ...v.host, routes: [{ name: "VPS", url: "https://changed.example.com" }] } } }; f.notify(); });
  await save(page); await expect(page.getByRole("alert")).toContainText("已在其他窗口更改");
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes)).toEqual([]);
});
test("failed save remains editable and requires reading state before treating it as saved", async ({ page }) => {
  await enter(page); await page.evaluate(() => { (window as any).localRelayFixture.state.failWrite = true; });
  await save(page); await expect(page.getByRole("alert")).toContainText("未能确认保存结果");
  await expect(page.getByRole("button", { name: "关闭连接状态与线路", exact: true })).toBeEnabled();
  await expect(page.getByLabel("中转地址", { exact: true })).toHaveValue("https://relay.example.com:8445");
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("opening an empty relay editor is not an unsaved change", async ({ page }) => {
  await page.getByRole("button", { name: "添加 VPS 中转", exact: true }).click();
  await expect(page.getByRole("button", { name: "验证并保存中转", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "关闭连接状态与线路", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).localRelayFixture.state.writes)).toEqual([]);
});
