import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, mobileHome, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
const row = (page: Page, title: string) => mobileHome(page).locator(".mh-row").filter({ has: page.getByText(title, { exact: true }) });
const sheet = (page: Page) => page.getByRole("dialog", { name: /^(对话|群组)操作$/ });
async function pair(page: Page, hub: HubServer, name = "手机测试主机") {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await waitForClientOnline(page);
}
async function seed(hub: HubServer) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','精灵助手','fixture')");
  await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_chat','direct','周末计划','owner',1,'direct')");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','user','owner',0)");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','bot','alpha',0)");
  const chat = (await hub.store.conversations("owner")).find(c => c.id === "same_chat")!;
  await hub.store.createConversation("owner", ["alpha"], "保留草稿", "other");
  const group = await hub.store.createConversation("owner", ["alpha"], "旅行群组", "group", { type: "group" });
  const topic = await hub.store.createConversation("owner", ["alpha"], "机票安排", "topic", { type: "group", parentId: group.id });
  await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "可以长按整理对话" }], status: "complete" });
  return { chat, group, topic };
}
const down = (target: Locator, extra = {}) => target.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: 130, clientY: 270, ...extra });
const up = (target: Locator) => target.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0 });
async function hold(page: Page, target: Locator) { await down(target); await expect(sheet(page)).toBeVisible(); await up(target); }

test("phone hold opens real actions, suppresses release click, pins durably and confirms deletion", async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phone-actions-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    const { chat } = await seed(hub);
    await page.goto(hub.url); await pair(page, hub);
    const target = row(page, "周末计划");
    expect(await target.locator(".mh-row-preview").evaluate(el => getComputedStyle(el).userSelect)).toBe("none");
    if (browser.browserType().name() === "chromium") {
      const cdp = await page.context().newCDPSession(page), bounds = (await target.boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + 110, y: bounds.y + 30 }] });
      await expect(sheet(page)).toBeVisible();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else await hold(page, target);
    await expect(sheet(page).getByRole("button")).toHaveText(["", "多选", "全局置顶", "分组置顶", "移至分组", "设置对话头像", "重命名", "删除对话"]);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
    await expect(mobileHome(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath("phone-conversation-actions.png") });
    await sheet(page).getByRole("button", { name: "分组置顶", exact: true }).tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect(target.getByLabel("已分组置顶", { exact: true })).toBeVisible();
    await expect(target).toBeFocused();
    await page.reload(); await waitForClientOnline(page);
    await expect(target.getByLabel("已分组置顶", { exact: true })).toBeVisible();
    await hold(page, target); await sheet(page).getByRole("button", { name: "全局置顶", exact: true }).tap();
    await expect(mobileHome(page).locator('.global-pin-section [data-conversation-id]')).toHaveAttribute('data-conversation-id', chat.id);
    await expect(target.getByLabel("已全局置顶", { exact: true })).toBeVisible();
    await expect(target).toBeFocused();
    await page.screenshot({ path: info.outputPath("phone-global-pins.png") });
    await hold(page, target); await sheet(page).getByRole("button", { name: "取消全局置顶", exact: true }).tap();
    await expect(mobileHome(page).locator('.global-pin-section')).toHaveCount(0);
    await expect(target.getByLabel("已分组置顶", { exact: true })).toBeVisible();
    await hold(page, target); await sheet(page).getByRole("button", { name: "取消分组置顶", exact: true }).tap();
    await expect(target.getByLabel("已分组置顶", { exact: true })).toHaveCount(0);
    await target.press("Shift+F10"); await sheet(page).getByRole("button", { name: "删除对话", exact: true }).tap();
    const confirm = page.getByRole("dialog", { name: "删除对话", exact: true });
    await expect(confirm.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    expect((await hub.store.conversations("owner")).find(c => c.id === chat.id)!.archived).toBe(false);
    await confirm.getByRole("button", { name: "取消", exact: true }).tap(); await expect(target).toBeFocused();
    await hold(page, target); await sheet(page).getByRole("button", { name: "删除对话", exact: true }).tap();
    await confirm.getByRole("button", { name: "删除对话", exact: true }).tap();
    await expect(confirm).toHaveCount(0); await expect(target).toHaveCount(0);
    expect((await hub.store.conversations("owner")).find(c => c.id === chat.id)!.archived).toBe(true);
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", [chat.id])).toEqual({ count: 1 });
    await expect(mobileHome(page)).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("scroll, short taps, cancellation and switching tabs never fire a delayed hold", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phone-hold-cancel-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await seed(hub); for (let i = 0; i < 20; i++) await hub.store.createConversation("owner", ["alpha"], `列表对话 ${i}`, `scroll_${i}`);
    await page.goto(hub.url); await pair(page, hub);
    const target = row(page, "周末计划");
    for (const reason of ["move", "release", "cancel", "multi", "blur", "scroll"]) {
      await target.scrollIntoViewIfNeeded(); await down(target);
      if (reason === "move") await target.dispatchEvent("pointermove", { pointerId: 7, pointerType: "touch", clientX: 130, clientY: 310 });
      if (reason === "release") await up(target);
      if (reason === "cancel") await target.dispatchEvent("pointercancel", { pointerId: 7 });
      if (reason === "multi") await down(target, { pointerId: 8, isPrimary: false });
      if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      if (reason === "scroll") await mobileHome(page).locator(".mh-body").evaluate(el => { el.scrollTop += el.scrollTop > 30 ? -40 : 40; el.dispatchEvent(new Event("scroll")); });
      // Some WebViews emit a legacy MouseEvent contextmenu after cancellation.
      // It must not resurrect a gesture that has already become a scroll.
      await target.dispatchEvent("contextmenu", { button: 0 });
      await page.waitForTimeout(620); await expect(sheet(page), reason).toHaveCount(0); await up(target);
    }
    await down(target); await mobileHome(page).getByRole("button", { name: "我的", exact: true }).tap();
    await page.waitForTimeout(620); await expect(sheet(page)).toHaveCount(0);
    await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^消息/ }).tap();
    await target.tap(); await expect(page.getByRole("heading", { name: "周末计划", exact: true, level: 1 })).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group dissolution confirms scope, hides topics and keeps history restorable; offline pin still works", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phone-group-actions-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    const { group, topic } = await seed(hub); await page.goto(hub.url); await pair(page, hub);
    await hold(page, row(page, "旅行群组"));
    await sheet(page).getByRole("button", { name: "解散群组", exact: true }).tap();
    const confirm = page.getByRole("dialog", { name: "解散群组", exact: true });
    await expect(confirm).toContainText("我的 / 工作台 → 已归档对话");
    await page.setViewportSize({ width: 320, height: 740 });
    // Let visualViewport-driven layout settle before recording the smaller
    // screen. WebKit can otherwise capture the pre-resize top-layer frame.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(confirm).toBeInViewport();
    await page.screenshot({ path: info.outputPath("phone-dissolve-confirm.png"), animations: "disabled" });
    expect(await confirm.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await confirm.getByRole("button", { name: "解散群组", exact: true }).tap();
    await expect(confirm).toHaveCount(0); await expect(row(page, "旅行群组")).toHaveCount(0);
    expect((await hub.store.conversations("owner")).find(c => c.id === topic.id)).toBeDefined();
    await mobileHome(page).getByRole("button", { name: "我的", exact: true }).tap();
    await mobileHome(page).getByRole("button", { name: "已归档对话", exact: true }).tap();
    await page.getByRole("dialog", { name: "已归档对话", exact: true }).getByRole("article", { name: "旅行群组", exact: true }).getByRole("button", { name: "恢复", exact: true }).tap();
    await expect(page.getByRole("dialog", { name: "已归档对话", exact: true })).toHaveCount(0);
    expect((await hub.store.conversations("owner")).find(c => c.id === group.id)!.archived).toBe(false);
    await page.getByRole("button", { name: "打开会话列表", exact: true }).tap();
    await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^消息/ }).tap();
    await expect(row(page, "旅行群组")).toBeVisible();
    await hub.close();
    await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toHaveCount(0);
    await hold(page, row(page, "周末计划"));
    await expect(sheet(page).getByRole("button", { name: "删除对话", exact: true })).toBeDisabled();
    await expect(sheet(page).getByRole("button", { name: "重命名", exact: true })).toBeDisabled();
    await sheet(page).getByRole("button", { name: "分组置顶", exact: true }).tap();
    await expect(row(page, "周末计划").getByLabel("已分组置顶", { exact: true })).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("Me opens notification setup directly and does not claim an unconfigured host can deliver", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phone-notification-entry-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await seed(hub); await page.goto(hub.url); await pair(page, hub);
    await mobileHome(page).getByRole("button", { name: "我的", exact: true }).tap();
    const entry = mobileHome(page).getByRole("button", { name: /^消息通知/ });
    await expect(entry).toContainText("后台推送尚未配置");
    await page.screenshot({ path: info.outputPath("phone-notification-entry.png") });
    await entry.tap();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
    await expect(settings.getByText(/此主机尚未配置浏览器推送|此浏览器不支持后台提醒/)).toBeVisible();
    await expect(settings.getByRole("switch", { name: "消息提醒", exact: true })).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect(settings).toHaveCount(0); await expect(entry).toBeFocused();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("mobile actions target the held host even with matching conversation IDs", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phone-actions-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    const { chat } = await seed(a); await seed(b);
    // Equal IDs are deliberate: selecting a host by the current workspace would
    // write the wrong conversation while appearing to succeed.
    expect((await b.store.conversations("owner")).find(c => c.title === "周末计划")!.id).toBe(chat.id);
    await page.goto(a.url); await pair(page, a, "主机甲");
    await mobileHome(page).getByRole("button", { name: "我的", exact: true }).tap();
    await mobileHome(page).getByRole("button", { name: "设备与网络", exact: true }).tap();
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: /^此设备连接另一台主机/ }).tap();
    await pair(page, b, "主机乙");
    const target = row(page, "周末计划").filter({ hasText: "主机甲" });
    const other = row(page, "周末计划").filter({ hasText: "主机乙" });
    await hold(page, target);
    await expect(sheet(page)).toContainText("运行于 主机甲");
    await sheet(page).getByRole("button", { name: "分组置顶", exact: true }).tap();
    await expect(target.getByLabel("已分组置顶", { exact: true })).toBeVisible();
    await expect(other.getByLabel("已分组置顶", { exact: true })).toHaveCount(0);
    await hold(page, target); await sheet(page).getByRole("button", { name: "删除对话", exact: true }).tap();
    await page.getByRole("dialog", { name: "删除对话", exact: true }).getByRole("button", { name: "删除对话", exact: true }).tap();
    await expect(target).toHaveCount(0); await expect(other).toBeVisible();
    expect((await a.store.conversations("owner")).find(c => c.id === chat.id)!.archived).toBe(true);
    expect((await b.store.conversations("owner")).find(c => c.title === "周末计划")!.archived).toBe(false);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});
