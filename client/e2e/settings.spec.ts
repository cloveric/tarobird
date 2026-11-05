import { preparePairing } from "./fixtures/pairing-invite.js";
import { openSettings, closeSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { enterMobileChat, mobileChatAction, mobileHome, openWorkspacePage, showDisconnectedBots } from "./fixtures/mobile.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

test("desktop settings return focus without a pointer ring and retain keyboard navigation", async ({ page, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-focus-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "焦点回归", "focus");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    const gear = page.getByRole("button", { name: "设置", exact: true });
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    const nextControl = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
    const previousControl = browserName === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab";
    for (const palette of ["mono", "cli"]) {
      await page.evaluate(value => { document.documentElement.dataset.palette = value; }, palette);
      await gear.click();
      const close = settings.getByRole("button", { name: "关闭设置", exact: true });
      await expect(close).toBeFocused();
      await expect(close).toHaveCSS("outline-style", "none");
      await close.click();
      await expect(gear).toBeFocused();
      await expect(gear).toHaveCSS("outline-style", "none");
      // A browser window round trip exercises retained focus; this is not a
      // substitute for native macOS Dock/tray activation acceptance.
      const other = await page.context().newPage();
      await other.bringToFront(); await page.bringToFront(); await other.close();
      await expect(gear).toBeFocused();
      await expect(gear).toHaveCSS("outline-style", "none");
      await page.keyboard.press(previousControl);
      await page.keyboard.press(nextControl);
      await expect(gear).toBeFocused();
      await expect(gear).toHaveCSS("outline-style", "solid");
      await expect(gear).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Enter");
      await expect(settings).toBeVisible();
      await expect(close).toBeFocused();
      await expect(close).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Escape");
      await expect(gear).toBeFocused();
      await expect(gear).toHaveCSS("outline-style", "solid");
      // A pointer action must clear an earlier keyboard ring as well.
      await gear.click(); await close.click();
      await expect(gear).toBeFocused();
      await expect(gear).toHaveCSS("outline-style", "none");
    }
    await page.screenshot({ path: info.outputPath("settings-pointer-return.png") });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

async function dragSettings(page: Page, dialog: Locator, phone: boolean, dx = 100, dy = 24) {
  await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))));
  const before = (await dialog.boundingBox())!, header = (await dialog.locator(":scope>header").boundingBox())!;
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.down(); await page.mouse.move(header.x + header.width / 2 + dx, header.y + header.height / 2 + dy, { steps: 8 }); await page.mouse.up();
  const after = (await dialog.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(phone ? 0 : dx, 0);
  expect(after.y - before.y).toBeCloseTo(phone ? 0 : dy, 0);
  await expect(dialog).not.toHaveAttribute("data-dragging", "true");
}

for (const phone of [false, true]) test(`connection shortcuts and settings category share the guarded route editor (${phone ? "phone" : "desktop"})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-navigation-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await hub.profile.update({ name: "工作电脑", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "设置回归", "settings");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await openWorkspacePage(page, "设置");
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^网络与连接/ }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await dragSettings(page, settings, phone);
    const networkPage = settings.getByRole("region", { name: "网络与连接", exact: true });
    await expect(networkPage.getByRole("button", { name: /^设备与网络/ })).toBeVisible();
    await expect(networkPage.locator(".network-settings-current")).toContainText("已连接");
    await networkPage.getByRole("button", { name: /^连接状态与线路/ }).click();
    const child = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
    await expect(child).toBeVisible();
    await dragSettings(page, child, phone);
    await child.getByRole("button", { name: "编辑线路", exact: true }).click();
    await child.getByLabel("主机的直连地址（可选）", { exact: true }).fill("https://unsaved.example.test");
    await dragSettings(page, child, phone, -80, -24);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(child.getByLabel("主机的直连地址（可选）", { exact: true })).toHaveValue("https://unsaved.example.test");
    await child.getByRole("button", { name: "返回网络与连接", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(child).toHaveCount(0);
    await expect(networkPage.getByRole("button", { name: /^连接状态与线路/ })).toBeFocused();
    await networkPage.getByRole("button", { name: /^设备与网络/ }).click();
    const network = page.getByRole("dialog", { name: "设备与网络", exact: true });
    await expect(network).toBeVisible();
    await dragSettings(page, network, phone);
    // A normal network action must keep the settings page and its context.
    await network.getByRole("button", { name: "此设备的连接", exact: true }).click();
    await page.getByRole("dialog", { name: "此设备的连接", exact: true }).getByRole("button", { name: "关闭连接管理", exact: true }).click();
    await expect(network.getByRole("button", { name: "此设备的连接", exact: true })).toBeFocused();
    await network.getByRole("button", { name: "添加设备", exact: true }).click();
    const invite = page.getByRole("dialog", { name: "添加设备", exact: true });
    await expect(invite.getByRole("heading", { name: "让新手机或电脑扫描二维码", exact: true })).toBeVisible();
    // Direct invitation must not open the intermediate permissions page.
    await expect(page.getByRole("dialog", { name: "设备与安全", exact: true })).toHaveCount(0);
    await invite.getByRole("button", { name: "关闭添加设备", exact: true }).click();
    await expect(network.getByRole("button", { name: "添加设备", exact: true })).toBeFocused();
    await network.getByRole("button", { name: "管理访问设备", exact: true }).click();
    const deviceSettings = page.getByRole("dialog", { name: "设备与安全", exact: true });
    await expect(deviceSettings.getByRole("navigation", { name: "设置分类" })).toHaveCount(0);
    await expect(deviceSettings.getByRole("region", { name: "设备与安全", exact: true }).locator(".device-host-scope")).toHaveText("管理主机：工作电脑");
    const approve = deviceSettings.getByRole("button", { name: "输入配对码确认", exact: true });
    await expect(approve).toBeInViewport();
    await approve.click();
    await expect(invite.getByRole("heading", { name: "输入新设备上的 8 位配对码", exact: true })).toBeVisible();
    await invite.getByRole("button", { name: "关闭添加设备", exact: true }).click();
    await deviceSettings.screenshot({ path: info.outputPath(`network-device-approval-${phone ? "phone" : "desktop"}.png`) });
    await deviceSettings.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(network).toBeVisible();
    await page.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await expect(networkPage.getByRole("button", { name: /^设备与网络/ })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`network-settings-${phone ? "phone" : "desktop"}.png`), animations: "disabled" });
    await networkPage.getByRole("button", { name: /^此设备的连接/ }).click();
    const savedConnections = page.getByRole("dialog", { name: "此设备的连接", exact: true });
    await savedConnections.getByRole("button", { name: "设置连接", exact: true }).click();
    await page.getByRole("button", { name: "返回此设备的连接", exact: true }).click();
    await expect(savedConnections.getByRole("button", { name: "设置连接", exact: true })).toBeFocused();
    await savedConnections.getByRole("button", { name: "关闭连接管理", exact: true }).click();
    await expect(networkPage.getByRole("button", { name: /^此设备的连接/ })).toBeFocused();
    if (phone) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^设备与安全/ }).click();
    await expect(settings.locator(".settings-danger")).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "添加设备", exact: true })).toBeVisible();
    await closeSettings(page);
    if (!phone) await page.getByRole("button", { name: /^工作台：/ }).click();
    const container = phone ? mobileHome(page) : page.getByRole("group", { name: "工作台", exact: true });
    const connectionEntry = container.getByRole("button", { name: "连接状态与线路", exact: true });
    const networkEntry = container.getByRole("button", { name: "设备与网络", exact: true });
    await networkEntry.scrollIntoViewIfNeeded();
    if (phone) expect((await networkEntry.boundingBox())!.y).toBeLessThan((await connectionEntry.boundingBox())!.y);
    else expect((await connectionEntry.boundingBox())!.y).toBeLessThan((await networkEntry.boundingBox())!.y);
    await page.screenshot({ path: info.outputPath(`connection-entry-${phone ? "phone" : "desktop"}.png`), animations: "disabled" });
    await connectionEntry.click();
    const panel = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
    await expect(panel).toBeVisible(); await expect(panel.getByRole("navigation")).toHaveCount(0);
    await page.getByRole("button", { name: "编辑线路", exact: true }).click();
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    const address = page.getByLabel("主机的直连地址（可选）", { exact: true }); await address.fill("invalid-address");
    await page.getByRole("button", { name: "保存线路", exact: true }).click(); await expect(page.getByText("请输入有效 Hub HTTPS 地址", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭连接状态与线路", exact: true }).click();
    await expect(page.getByRole("heading", { name: "放弃未保存的修改？" })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click(); await expect(address).toHaveValue("invalid-address");
    await page.keyboard.press("Escape"); await expect(page.getByRole("heading", { name: "放弃未保存的修改？" })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(address).toHaveValue("invalid-address");
    await page.getByRole("button", { name: "取消", exact: true }).click(); await page.getByRole("button", { name: "编辑线路", exact: true }).click(); await expect(address).toHaveValue(hub.url);
    await page.screenshot({ path: info.outputPath(`connection-editor-${phone ? "phone" : "desktop"}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (phone) {
      await page.setViewportSize({ width: 320, height: 780 });
      await expect(page.getByRole("button", { name: "关闭连接状态与线路", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "保存线路", exact: true })).toBeInViewport();
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("connection-editor-320px.png"), animations: "disabled" });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByRole("button", { name: "关闭连接状态与线路", exact: true }).click(); await expect(panel).toHaveCount(0);
    if (phone) await expect(mobileHome(page).getByRole("button", { name: "连接状态与线路", exact: true })).toBeFocused();
    await openSettings(page, "devices"); await openDevicePairing(page);
    await expect(page.getByRole("button", { name: "确认配对", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "扫描新设备配对码", exact: true }).click(); await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "扫描新设备配对码", exact: true })).toBeFocused();
    await closeDevicePairing(page); await closeSettings(page);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("phone settings titles and Escape follow page depth without discarding a route draft", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-phone-depth-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "页面层级", "depth");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    await showDisconnectedBots(page); await enterMobileChat(page, "页面层级");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("聊天草稿仍在");
    await mobileChatAction(page, "打开连接设置");
    const settings = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
    await expect(settings.getByRole("heading", { name: "连接状态与线路", level: 2, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑线路", exact: true }).click();
    const address = page.getByLabel("主机的直连地址（可选）", { exact: true });
    await address.fill("draft-address");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "放弃未保存的修改？", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(address).toHaveValue("draft-address");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(page.getByRole("button", { name: "更多聊天操作", exact: true })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("聊天草稿仍在");
    await openSettings(page, "connection");
    await address.fill("draft-address");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "放弃未保存的修改？", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(mobileHome(page).getByRole("button", { name: "连接状态与线路", exact: true })).toBeFocused();
    await mobileHome(page).getByRole("button", { name: "设置", exact: true }).click();
    const generalSettings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(generalSettings.getByRole("heading", { name: "设置", level: 2, exact: true })).toBeVisible();
    // Rotating through the desktop breakpoint must preserve focus, even on the
    // navigation button itself; it must not remount behind the modal dialog.
    await expect(generalSettings.getByRole("button", { name: "关闭设置", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(generalSettings.getByRole("button", { name: "关闭设置", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(generalSettings.getByRole("button", { name: "关闭设置", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(generalSettings).toHaveCount(0);
    await expect(mobileHome(page).getByRole("button", { name: "设置", exact: true })).toBeFocused();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failed network page chunk preserves the workspace and offers a deliberate reload", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "network-page-load-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const chunk = /\/assets\/NetworkManager-.*\.js$/;
  await page.route(chunk, route => route.abort());
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "网络加载检查", "network-load");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("页面加载失败也应保留的草稿");
    await openWorkspacePage(page, "设置");
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^网络与连接/ }).click();
    await page.getByRole("region", { name: "网络与连接", exact: true }).getByRole("button", { name: /^设备与网络/ }).click();
    const failure = page.getByRole("dialog", { name: "页面暂时无法打开", exact: true });
    await expect(failure).toBeVisible();
    await expect(failure.getByRole("button", { name: "重新加载应用", exact: true })).toBeVisible();
    await failure.getByRole("button", { name: "关闭此页", exact: true }).click();
    await expect(failure).toHaveCount(0);
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(composer).toHaveValue("页面加载失败也应保留的草稿");
    await page.unroute(chunk); await page.reload();
    await openWorkspacePage(page, "设置");
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^网络与连接/ }).click();
    await page.getByRole("region", { name: "网络与连接", exact: true }).getByRole("button", { name: /^设备与网络/ }).click();
    await expect(page.getByRole("dialog", { name: "设备与网络", exact: true })).toBeVisible();
    await expect(composer).toHaveValue("页面加载失败也应保留的草稿");
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
