import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { mobileHome, openFolderManager, openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { expectSettingsPage } from "./fixtures/settings-page.js";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
for (const platform of ["android", "ios"] as const) test(`${platform} settings remain full pages through nested navigation, rotation and keyboard resize`, async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-fullscreen-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const dialog = (name: string) => page.getByRole("dialog", { name, exact: true });
  const insets = async (landscape = false) => page.evaluate(({ platform, landscape }) => {
    const root = document.documentElement;
    root.dataset.platform = platform;
    const safe = platform === "ios" ? landscape ? [0, 10, 21, 59] : [59, 0, 34, 0] : [0, 0, 0, 0];
    ["top", "right", "bottom", "left"].forEach((side, index) => root.style.setProperty(`--safe-area-inset-${side}`, `${safe[index]}px`));
  }, { platform, landscape });
  try {
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await insets();
    await openWorkspacePage(page, "设备与网络");
    const network = dialog("设备与网络");
    await expectSettingsPage(network, 390, 844);
    await page.screenshot({ path: info.outputPath(`${platform}-network-fullscreen.png`), animations: "disabled" });
    await network.getByRole("button", { name: "此设备的连接", exact: true }).click();
    const connections = dialog("此设备的连接"); await expectSettingsPage(connections, 390, 844);
    await connections.getByRole("button", { name: "修改名称", exact: true }).click();
    const rename = dialog("修改主机名称"), name = rename.getByLabel("主机名称", { exact: true });
    await name.fill("旋转后仍保留的名称"); await expectSettingsPage(rename, 390, 844);
    if (platform === "ios") {
      await page.evaluate(() => document.documentElement.style.setProperty("--safe-area-inset-left", "24px"));
      await expectSettingsPage(rename, 390, 844);
    }
    await page.setViewportSize({ width: 844, height: 390 }); await insets(true);
    await expectSettingsPage(rename, 844, 390); await expect(name).toHaveValue("旋转后仍保留的名称");
    await name.focus();
    await page.evaluate(() => { const root = document.documentElement; root.dataset.keyboardOpen = "true"; root.style.setProperty("--shell-height", "240px"); });
    await expectSettingsPage(rename, 844, 240);
    await expect.poll(() => name.evaluate(node => { const r = node.getBoundingClientRect(); return r.top >= 60 && r.bottom <= 240; })).toBe(true);
    await expect(rename.getByRole("button", { name: "返回此设备的连接", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`${platform}-rename-landscape-keyboard.png`), animations: "disabled" });
    await page.evaluate(() => { delete document.documentElement.dataset.keyboardOpen; document.documentElement.style.removeProperty("--shell-height"); });
    await page.setViewportSize({ width: 390, height: 844 }); await insets();
    await rename.getByRole("button", { name: "返回此设备的连接", exact: true }).click();
    const confirmation = dialog("放弃主机名称修改？");
    await expect(confirmation).toBeVisible(); expect((await confirmation.boundingBox())!.height).toBeLessThan(422);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(confirmation).toHaveCount(0); await expect(name).toHaveValue("旋转后仍保留的名称");
    await rename.getByRole("button", { name: "返回此设备的连接", exact: true }).click();
    await confirmation.getByRole("button", { name: "放弃修改", exact: true }).click();
    await connections.getByRole("button", { name: "关闭连接管理", exact: true }).click();
    await expect(network.getByRole("button", { name: "此设备的连接", exact: true })).toBeFocused();
    await network.getByRole("button", { name: "添加设备", exact: true }).click();
    const invite = dialog("添加设备"); await expectSettingsPage(invite, 390, 844);
    await invite.getByRole("button", { name: "已扫码，输入配对码", exact: true }).click();
    await invite.getByLabel("新设备配对码", { exact: true }).fill("12345678");
    await invite.getByRole("button", { name: "返回", exact: true }).click();
    await expect(invite.getByRole("heading", { name: "让新手机或电脑扫描二维码", exact: true })).toBeVisible();
    await invite.getByRole("button", { name: "关闭添加设备", exact: true }).click();
    await network.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    for (const section of ["general", "notifications", "devices", "connection"] as const) {
      await openSettings(page, section);
      const settings = page.locator("dialog.preferences-dialog:modal").last();
      await expectSettingsPage(settings, 390, 844);
      if (platform === "ios") {
        await page.evaluate(() => document.documentElement.style.setProperty("--safe-area-inset-left", "24px"));
        await expectSettingsPage(settings, 390, 844);
        expect(await settings.locator(":scope > header > button").first().evaluate(node => Math.round(node.getBoundingClientRect().left))).toBe(36);
        await expect.poll(() => settings.locator(".settings-content").evaluate(node => Math.round(node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft)))).toBe(40);
      }
      await page.setViewportSize({ width: 844, height: 390 }); await insets(true);
      await expectSettingsPage(settings, 844, 390);
      await page.setViewportSize({ width: 390, height: 844 }); await insets();
      await closeSettings(page);
    }
    await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^消息/ }).click();
    await openFolderManager(page);
    const folders = dialog("管理分组"); await expectSettingsPage(folders, 390, 844);
    await folders.getByRole("button", { name: "新建分组", exact: true }).click();
    const create = dialog("新建分组"); await create.getByLabel("分组名称").fill("未提交分组");
    await create.getByRole("button", { name: "返回", exact: true }).click();
    await expect(folders).toBeVisible(); await expect(create).toHaveCount(0);
    await folders.getByRole("button", { name: "新建分组", exact: true }).click();
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(folders).toBeVisible();
    await folders.getByRole("button", { name: "关闭分组", exact: true }).click();
    expect((await hub.profile.read()).name).not.toBe("旋转后仍保留的名称");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
