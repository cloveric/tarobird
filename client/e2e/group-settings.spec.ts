import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
// The supported older iPhone WebKit lacks these static methods. Exercise the
// real panel and its bounded-request fallback, including effect cleanup.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  });
});
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
const menu = (page: Page) => page.getByRole("menu", { name: "群组操作", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "群组设置", exact: true });
async function pair(page: Page, hub: HubServer, name = "测试主机", add = false) {
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
  if (add) await clickAppAction(page, "连接另一台主机"); else await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}
async function seed(hub: HubServer) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','写作助手','fixture')");
  await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_group','group','产品群','owner',1,'group')");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_group','user','owner',0),('same_group','bot','alpha',0)");
  return hub.store.createConversation("owner", [], "发布话题", "topic", { parentId: "same_group" });
}
async function open(page: Page) {
  await workspace(page).locator(".group-tree-heading .conversation-row").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "群组设置", exact: true }).click();
}

test("empty reply recipients remain visibly focusable from the keyboard", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recipient-keyboard-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await seed(hub); await pair(page, hub);
    await workspace(page).locator(".group-tree-heading .conversation-row").click();
    const chip = workspace(page).locator(".composer-recipients.is-empty");
    await expect(chip).toBeVisible();
    for (const palette of ["mono", "white-violet"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ palette, theme }) => {
        document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme;
      }, { palette, theme });
      await chip.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      await expect(chip).toBeFocused();
      await expect(chip).toHaveCSS("outline-style", "solid");
      await expect(chip).toHaveCSS("outline-width", "2px");
    }
    await chip.click(); await page.keyboard.press("Escape");
    // A new pointer interaction restores the quiet pointer presentation.
    await chip.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0 });
    await expect(chip).not.toHaveCSS("outline-width", "2px");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group menu edits the clicked group, synchronizes topic members and keeps another chat's draft", async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext(), observer = await context.newPage();
  try {
    const topic = await seed(hub); await hub.store.createConversation("owner", ["alpha"], "草稿对话", "draft");
    await pair(page, hub); await pair(observer, hub);
    // This fixture intentionally has no Gateway. Opt in to offline history
    // before selecting a direct chat; the default correctly hides those Bots.
    await showDisconnectedBots(page);
    await workspace(page).locator(".conversation-row").filter({ hasText: "草稿对话" }).click();
    await workspace(page).getByLabel("消息", { exact: true }).fill("保留的草稿");
    const heading = workspace(page).locator(".group-tree-heading");
    await heading.locator(".profile-avatar-group").click({ button: "right" });
    await expect(menu(page).getByRole("menuitem")).toHaveText(["群组设置", "添加 / 移除 Bot", "多选", "全局置顶", "分组置顶", "移至分组", "重命名群组F2", "删除群组"]);
    await page.screenshot({ path: info.outputPath("group-menu-desktop.png") }); await page.keyboard.press("Escape");
    // The expansion button is part of the same context target, not a native-menu hole.
    await heading.locator(".group-toggle").click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "添加 / 移除 Bot", exact: true }).click();
    await expect(dialog(page).getByRole("group", { name: /群组 Bot/ })).toBeFocused();
    await dialog(page).getByRole("checkbox", { name: "写作助手", exact: true }).check();
    await dialog(page).getByLabel("群组名称", { exact: true }).fill("产品讨论群");
    await page.screenshot({ path: info.outputPath("group-settings-desktop.png") });
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
    await expect(workspace(observer).locator(".conversation-row").filter({ hasText: "产品讨论群" })).toBeVisible();
    expect((await hub.store.conversations("owner")).find(c => c.id === topic.id)).toMatchObject({ title: "发布话题", botIds: ["alpha", "beta"] });
    await expect(workspace(page).getByLabel("消息", { exact: true })).toHaveValue("保留的草稿");
    await open(page); await dialog(page).getByRole("checkbox", { name: "研究助手", exact: true }).uncheck();
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
    await heading.locator(".group-toggle").press("Shift+F10");
    await menu(page).getByRole("menuitem", { name: "群组设置", exact: true }).click();
    await dialog(page).getByRole("checkbox", { name: "写作助手", exact: true }).uncheck();
    await expect(dialog(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "关闭群组设置", exact: true }).click();
    await page.getByRole("button", { name: "继续编辑", exact: true }).last().click();
    await expect(dialog(page).getByRole("checkbox", { name: "写作助手", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "关闭群组设置", exact: true }).click(); await page.getByRole("button", { name: "放弃更改", exact: true }).click();
    await page.reload(); await open(page); await expect(dialog(page).getByRole("checkbox", { name: "写作助手", exact: true })).toBeChecked(); await expect(dialog(page).getByRole("checkbox", { name: "研究助手", exact: true })).not.toBeChecked();
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group settings respect cross-host ownership, stale edits, pending work and offline reads", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    const topic = await seed(a); await seed(b); await pair(page, a, "主机甲"); await pair(page, b, "主机乙", true);
    await setListOption(page, '按主机分组', true);
    const target = workspace(page).getByRole("region", { name: "主机：主机甲", exact: true }).locator(".group-tree-heading .conversation-row");
    await target.click({ button: "right" }); await menu(page).getByRole("menuitem", { name: "群组设置", exact: true }).click();
    await expect(dialog(page)).toContainText("运行于 主机甲");
    await dialog(page).getByRole("checkbox", { name: "写作助手", exact: true }).check();
    await a.store.updateConversation("owner", "same_group", { title: "其他设备的名称" });
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("群组已在其他设备修改");
    await dialog(page).getByRole("button", { name: "重新读取群组设置", exact: true }).click();
    await expect(dialog(page).getByLabel("群组名称", { exact: true })).toHaveValue("其他设备的名称");
    const work = await a.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "pending", text: "work", attachments: [], mentions: ["alpha"] });
    await dialog(page).getByRole("checkbox", { name: "写作助手", exact: true }).check(); await dialog(page).getByRole("checkbox", { name: "研究助手", exact: true }).uncheck();
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog(page).getByRole("alert")).toContainText("仍有排队或进行中的任务");
    await a.store.acknowledgeDelivery("alpha", work.message.id);
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
    expect((await b.store.conversations("owner"))[0]!).toMatchObject({ title: "产品群", botIds: ["alpha"] });
    // Identical group IDs on different hosts must use their own membership.
    for (const [host, bot] of [["主机甲", "beta"], ["主机乙", "alpha"]]) {
      const groupAvatar = workspace(page).getByRole("region", { name: `主机：${host}`, exact: true }).locator('.profile-avatar-group[data-avatar="group:same_group"]');
      await expect(groupAvatar).toHaveAttribute("data-composite", "1");
      await expect(groupAvatar.locator(`.group-avatar-members > [data-avatar="bot:${bot}"]`)).toHaveCount(1);
    }
    await a.close(); await expect(target).toContainText("其他设备的名称");
    await target.click({ button: "right" }); await expect(menu(page).getByRole("menuitem", { name: "添加 / 移除 Bot", exact: true })).toBeDisabled();
    await menu(page).getByRole("menuitem", { name: "群组设置", exact: true }).click();
    await expect(dialog(page).getByRole("checkbox", { name: "写作助手", exact: true })).toBeDisabled(); await expect(dialog(page)).toContainText("连接恢复后即可操作");
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("phone details offer group settings while inside a topic", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-phone-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await seed(hub); await pair(page, hub); await workspace(page).locator(".conversation-row").filter({ hasText: "发布话题" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await workspace(page).getByRole("button", { name: "查看对话详情", exact: true }).click();
    await page.getByRole("button", { name: "群组设置", exact: true }).click();
    await expect(dialog(page).getByLabel("群组名称", { exact: true })).toHaveValue("产品群");
    await dialog(page).getByRole("checkbox", { name: "写作助手", exact: true }).check();
    const box = await dialog(page).boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("group-settings-phone.png") });
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(workspace(page).getByRole("heading", { name: "发布话题", exact: true })).toBeVisible();
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
