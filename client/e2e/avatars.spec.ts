import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openBotSettings, closeBotSettings } from "./fixtures/bot-settings.js";
import { openSettings } from "./fixtures/settings.js";
import { showDisconnectedBots, mobileChatAction, mobileHome, openMobileHome, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { avatarFixture } from "../../tests/helpers/avatar-fixture.js";

test.use({ actionTimeout: 15_000 });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
async function picture(page: Page, color = 80) {
  await page.getByLabel("选择头像图片", { exact: true }).setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: avatarFixture(400, 300, color) });
  await expect(page.getByLabel("头像裁剪预览")).toBeVisible();
}
async function save(page: Page) { await page.getByRole("button", { name: "保存头像", exact: true }).click(); await expect(page.getByRole("button", { name: "关闭头像编辑" })).toHaveCount(0); }
// A synced picture must be visible somewhere real; hidden copies (desktop sidebar, phone header) must match it too.
async function rendered(page: Page, target: string, count?: number) {
  const imgs = page.locator(`[data-avatar="${target}"] img`);
  if (count !== undefined) await expect(imgs).toHaveCount(count);
  else await expect(imgs.filter({ visible: true }).first()).toBeVisible();
  if (count !== 0) await expect.poll(() => imgs.evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).naturalWidth === 256))).toBe(true);
}
const phoneTab = (page: Page, name: RegExp) => mobileHome(page).getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name }).click();

test("personal, Bot and group avatars crop, sync both ways, inherit in topics and resolve competing edits", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatars-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const dc = await browser.newContext(), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await dc.newPage(), phone = await pc.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const group = await hub.store.createConversation("owner", ["alpha"], "产品设计", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "头像设计", "topic", { parentId: group.id });
    await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "hello", text: "我们的头像可以同步了", attachments: [] });
    await hub.store.publishBotMessage("alpha", { conversationId: group.id, blocks: [{ type: "text", text: "群里的话题沿用群头像。" }] });
    await pair(desktop, hub); await pair(phone, hub); await selectConversation(desktop, group.title);
    await openSettings(desktop, "general");
    await desktop.getByRole("button", { name: "设置个人头像", exact: true }).click(); await picture(desktop);
    await desktop.getByRole("slider", { name: "缩放", exact: true }).fill("1.5");
    await desktop.getByRole("slider", { name: "水平位置", exact: true }).fill("0.2");
    await expect.poll(() => desktop.getByLabel("头像裁剪预览").evaluate((node) => {
      const pixel = (node as HTMLCanvasElement).getContext("2d")!.getImageData(128, 128, 1, 1).data;
      return [80, 140, 150, 255].every((value, i) => Math.abs(value - pixel[i]!) <= 1);
    })).toBe(true);
    await desktop.screenshot({ path: info.outputPath("avatar-crop-desktop.png") }); await save(desktop);
    await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    // Own messages carry no avatar, so the phone shows its personal picture on the Me page.
    await rendered(desktop, "user:owner"); await phoneTab(phone, /^我的/); await rendered(phone, "user:owner");
    await phoneTab(phone, /^消息/); await selectConversation(phone, group.title);
    await openBotSettings(desktop);
    await desktop.getByRole("button", { name: "设置Bot 头像", exact: true }).click(); await picture(desktop, 170); await save(desktop);
    await closeBotSettings(desktop);
    for (const page of [desktop, phone]) await rendered(page, "bot:alpha");
    for (const page of [desktop, phone]) await expect(page.locator(`[data-avatar="group:${group.id}"]`).first().locator('[data-avatar="bot:alpha"] img')).toHaveAttribute("src", /^blob:/);
    await mobileChatAction(phone, "对话设置"); await phone.getByRole("button", { name: "设置群头像", exact: true }).click(); await picture(phone, 220);
    await phone.getByRole("slider", { name: "缩放", exact: true }).fill("1.8");
    await phone.screenshot({ path: info.outputPath("avatar-crop-phone.png") }); await save(phone); await phone.getByRole("button", { name: "关闭对话设置", exact: true }).click();
    // The phone chat header hides avatars; the inbox row is where the group picture shows.
    await openMobileHome(phone);
    for (const page of [desktop, phone]) await rendered(page, `group:${group.id}`);
    await desktop.screenshot({ path: info.outputPath("avatars-desktop.png") }); await phone.screenshot({ path: info.outputPath("avatars-phone.png") });
    await selectConversation(phone, topic.title, group.title); await mobileChatAction(phone, "对话设置");
    const topicSettings = phone.getByRole("dialog", { name: "对话设置", exact: true });
    await expect(topicSettings.locator(`[data-avatar="group:${group.id}"] img`)).toBeVisible(); await expect(topicSettings.getByText("话题沿用所属群的头像。", { exact: true })).toBeVisible();
    for (const page of [desktop, phone]) await openBotSettings(page);
    for (const page of [desktop, phone]) { await page.getByRole("button", { name: "设置Bot 头像", exact: true }).click(); await picture(page, page === desktop ? 100 : 250); }
    await save(desktop); await expect(phone.getByRole("alert")).toContainText("另一台设备"); await expect(phone.getByRole("button", { name: "保存头像", exact: true })).toBeDisabled();
    await phone.getByRole("button", { name: "保留裁剪，使用最新版本", exact: true }).click(); await save(phone);
    const avatars = new HubAvatars(hub.store); expect((await avatars.list("owner")).find((a) => a.kind === "bot")?.revision).toBe(3);
    await phone.getByRole("button", { name: "设置Bot 头像", exact: true }).click(); phone.once("dialog", (d) => d.accept()); await phone.getByRole("button", { name: "恢复系统头像", exact: true }).click();
    await expect(phone.getByRole("button", { name: "关闭头像编辑" })).toHaveCount(0);
    for (const page of [desktop, phone]) { await expect(page.locator('[data-avatar="bot:alpha"]').first()).toHaveAttribute("data-preset"); }
    await closeBotSettings(phone); await mobileChatAction(phone, "对话设置");
    await phone.getByRole("button", { name: "设置群头像", exact: true }).click(); phone.once("dialog", (d) => d.accept()); await phone.getByRole("button", { name: "移除头像", exact: true }).click();
    await expect(phone.getByRole("button", { name: "关闭头像编辑" })).toHaveCount(0);
    for (const page of [desktop, phone]) {
      await expect(page.locator(`[data-avatar="group:${group.id}"]`).first()).toHaveAttribute("data-composite", "1");
      await expect(page.locator(`[data-avatar="group:${group.id}"]`).first().locator('[data-avatar="bot:alpha"]')).toHaveAttribute("data-preset");
    }
    await closeBotSettings(desktop); await openSettings(desktop, "general"); await desktop.getByRole("button", { name: "设置个人头像", exact: true }).click();
    desktop.once("dialog", (d) => d.accept()); await desktop.getByRole("button", { name: "移除头像", exact: true }).click(); await expect(desktop.getByRole("button", { name: "关闭头像编辑" })).toHaveCount(0);
    for (const page of [desktop, phone]) await rendered(page, "user:owner", 0);
  } finally { await dc.close(); await pc.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("default group portraits track members across devices, topics and offline reload", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "group-portrait-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const dc = await browser.newContext(), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await dc.newPage(), phone = await pc.newPage();
  try {
    const bots = Array.from({ length: 10 }, (_, i) => `bot${i}`);
    for (const id of bots) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [id, `助手 ${id}`]);
    const group = await hub.store.createConversation("owner", bots.slice(0, 3), "组合头像群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "设计话题", "topic", { parentId: group.id });
    await pair(desktop, hub); await pair(phone, hub);
    const portrait = (page: Page) => page.locator(`[data-avatar="group:${group.id}"]`).filter({ visible: true }).first();
    const members = async (ids: string[]) => {
      for (const page of [desktop, phone]) {
        await expect(portrait(page)).toHaveAttribute("data-composite", String(Math.min(ids.length, 9)));
        await expect.poll(() => portrait(page).locator(".group-avatar-members > .profile-avatar").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-avatar")))).toEqual(ids.slice(0, 9).map(id => `bot:${id}`));
        await expect.poll(() => portrait(page).locator("img").evaluateAll(nodes => nodes.every(n => (n as HTMLImageElement).naturalWidth > 0))).toBe(true);
        expect(await portrait(page).evaluate(node => {
          const outer = node.getBoundingClientRect();
          const cells = [...node.querySelectorAll(".group-avatar-members > .profile-avatar")].map(n => n.getBoundingClientRect());
          return cells.every(r => r.width > 0 && Math.abs(r.width - r.height) < .1 && r.left >= outer.left && r.right <= outer.right + .1 && r.top >= outer.top && r.bottom <= outer.bottom + .1)
            && cells.every((a, i) => cells.slice(i + 1).every(b => a.right <= b.left + .1 || b.right <= a.left + .1 || a.bottom <= b.top + .1 || b.bottom <= a.top + .1));
        })).toBe(true);
      }
    };
    await members(bots.slice(0, 3));
    for (const ids of [1, 2, 4, 5, 8, 10].map(count => bots.slice(0, count)).concat([bots.slice(1), bots.slice(0, 3)])) {
      await desktop.locator(".group-tree-heading .conversation-row").filter({ hasText: group.title }).click({ button: "right" });
      await desktop.getByRole("menuitem", { name: "群组设置", exact: true }).click();
      const settings = desktop.getByRole("dialog", { name: "群组设置", exact: true });
      for (const id of bots) await settings.getByRole("checkbox", { name: `助手 ${id}`, exact: true }).setChecked(ids.includes(id));
      await settings.getByRole("button", { name: "保存", exact: true }).click(); await expect(settings).toHaveCount(0);
      await members(ids);
      if ([2, 4, 10].includes(ids.length)) await phone.screenshot({ path: info.outputPath(`group-${ids.length}-members.png`), animations: "disabled" });
    }
    await selectConversation(phone, topic.title, group.title);
    await expect(phone.locator(".chat-identity").locator(`[data-avatar="group:${group.id}"]`)).toHaveAttribute("data-composite", "3");
    await phone.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await expect(phone.locator(".details-identity").locator(`[data-avatar="group:${group.id}"]`)).toHaveAttribute("data-composite", "3");
    await phone.screenshot({ path: info.outputPath("group-topic-details.png"), animations: "disabled" });
    await phone.getByRole("button", { name: "返回聊天", exact: true }).click();
    await openMobileHome(phone);
    await phone.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => phone.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await hub.close(); await phone.reload({ waitUntil: "domcontentloaded" });
    await expect(portrait(phone)).toHaveAttribute("data-composite", "3");
    await expect.poll(() => portrait(phone).locator("img").evaluateAll(nodes => nodes.length === 3 && nodes.every(n => (n as HTMLImageElement).naturalWidth > 0))).toBe(true);
  } finally { await dc.close(); await pc.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancel and invalid images preserve the avatar, cached pictures survive offline reload", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatar-offline-")); let hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')"); await hub.store.createConversation("owner", ["alpha"], "离线头像", "offline");
    await pair(page, hub); await showDisconnectedBots(page); await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await openBotSettings(page); await page.getByRole("button", { name: "设置Bot 头像", exact: true }).click();
    await page.getByLabel("选择头像图片", { exact: true }).setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(page.getByRole("alert")).toContainText("PNG"); await expect(page.getByRole("button", { name: "保存头像", exact: true })).toBeDisabled();
    await picture(page); await page.getByRole("button", { name: "取消", exact: true }).click(); expect(await new HubAvatars(hub.store).list("owner")).toEqual([]);
    await page.getByRole("button", { name: "设置Bot 头像", exact: true }).click(); await picture(page); await save(page); await closeBotSettings(page); await rendered(page, "bot:alpha");
    await page.reload(); await expect(page.locator(".connection-pill.online")).toBeVisible(); await rendered(page, "bot:alpha");
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const port = Number(new URL(hub.url).port); await hub.close(); await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.locator(".app-shell")).toBeVisible(); await rendered(page, "bot:alpha");
    // A cold offline reload has cached portraits but no live Bot configuration.
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await expect(page.getByRole("button", { name: "Bot 设置", exact: true })).toBeDisabled();
    hub = await HubServer.start({ stateDir: root, port, clientDir: path.resolve("dist") }); await expect(page.locator(".connection-pill.online")).toBeVisible(); await openBotSettings(page); await expect(page.getByRole("button", { name: "设置Bot 头像", exact: true })).toBeEnabled();
    await closeBotSettings(page); await clickAppAction(page, "运行状态", page.getByRole("button", { name: "运行状态", exact: true }));
    await page.getByRole("button", { name: "设置Bot 头像", exact: true }).click(); await picture(page, 100); await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "关闭头像编辑" })).toHaveCount(0); await expect(page.getByRole("dialog", { name: "运行状态", exact: true })).toBeVisible();
    expect((await new HubAvatars(hub.store).list("owner"))[0]?.revision).toBe(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
