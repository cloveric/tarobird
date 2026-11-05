import { preparePairing } from "./fixtures/pairing-invite.js";
import { openSettings, closeSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { showDisconnectedBots, enterMobileChat, mobileChatAction, mobileHome } from "./fixtures/mobile.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

for (const width of [1360, 320]) test(`settings language changes preserve drafts and persist (${width}px)`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-language-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.setViewportSize({ width, height: 900 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','我的产品助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "用户命名的设计讨论", "settings-language");
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    await showDisconnectedBots(page);
    await enterMobileChat(page, "用户命名的设计讨论");

    const category = async (name: RegExp, english = false) => {
      if (width < 760) await page.getByRole("button", { name: english ? "Back to settings categories" : "返回设置分类", exact: true }).click();
      await page.getByRole("navigation", { name: english ? "Settings categories" : "设置分类" }).getByRole("button", { name }).click();
    };
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("语言切换前的草稿");
    await openSettings(page, "general");
    await page.locator("#language").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    // Endonyms make it possible to recover from choosing an unfamiliar language.
    await expect(page.locator('#language option[value="zh"]')).toHaveText("中文");
    await expect(page.locator('#language option[value="en"]')).toHaveText("English");
    if (width < 760) {
      expect(await page.locator('#language').evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      expect(await page.locator('#font-size').evaluate(e => {
        const control = e.getBoundingClientRect(), label = document.querySelector('label[for="font-size"]')!.getBoundingClientRect();
        return control.height >= 44 && Math.abs(control.top + control.height / 2 - label.top - label.height / 2) < 2;
      })).toBe(true);
    }

    await expect(page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^Connection/ })).toHaveCount(0);
    await category(/^Devices/, true); await openDevicePairing(page, true);
    await page.getByRole("textbox", { name: "New device pairing code", exact: true }).fill("1234");
    await expect(page.getByRole("button", { name: "Approve pairing", exact: true })).toBeDisabled(); await closeDevicePairing(page, true);
    await category(/^General/, true);
    await page.locator("#language").selectOption("zh");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await category(/^设备与安全/); await openDevicePairing(page);
    await expect(page.getByRole("textbox", { name: "新设备配对码", exact: true })).toHaveValue("1234"); await closeDevicePairing(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: width < 760 ? "返回设置分类" : "关闭设置", exact: true })).toBeInViewport();

    await category(/^通用/);
    await page.locator("#language").selectOption("en");
    await closeSettings(page, true);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    if (width < 760) await mobileHome(page).getByRole("button", { name: "Me", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^General/ }).click();
    await expect(page.locator("#language")).toHaveValue("en");
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`settings-language-${width}-en.png`) });
    if (width < 760) await page.locator('#theme').selectOption('dark');
    await closeSettings(page, true);
    if (width < 760) await mobileHome(page).getByRole('navigation', { name: 'Main navigation' }).getByRole("button", { name: /^Message/ }).click();
    await expect(page.getByText("用户命名的设计讨论", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("我的产品助手", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    if (width < 760) {
      await enterMobileChat(page, '用户命名的设计讨论');
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('语言切换前的草稿');
      await page.getByRole('button', {name:'More chat actions', exact:true}).click();
      const actions=page.getByRole('dialog',{name:'Chat actions',exact:true});
      await expect(actions.getByRole('button',{name:'Archived chats',exact:true})).toBeVisible();
      expect(await actions.getByRole('button',{name:'Open connection settings',exact:true}).locator('.action-label').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
      await expect(actions.getByRole('button',{name:'Stop current turn',exact:true})).toHaveAccessibleDescription(/No reply appears to be running/);
      // A clipped grid row can escape the panel even when the document itself
      // has no horizontal overflow. Check the actual action rows and chevrons.
      expect(await actions.locator('.mobile-chat-action-list').evaluateAll(groups=>groups.every(group=>
        [...group.querySelectorAll('button')].every(button=>{
          const panel=group.getBoundingClientRect(),row=button.getBoundingClientRect();
          return row.right<=panel.right+1 && row.left>=panel.left-1 &&
            [...button.querySelectorAll('.action-chevron')].every(icon=>icon.getBoundingClientRect().right<=row.right-8);
        })))).toBe(true);
      await page.screenshot({path:info.outputPath('actions-320-english-dark.png')});
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
