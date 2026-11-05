import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
const row = (page: Page, title: string) => workspace(page).locator(".conversation-row").filter({ has: page.locator("strong", { hasText: title }) });
async function pair(page: Page, hub: HubServer, name = "测试主机", add = false) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true })); else await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}
async function seed(hub: HubServer) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','测试助手','fixture')");
  await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id,session_id,binding_id) VALUES('same_chat','direct','原名称','owner',1,'same_action','existing_session','existing_binding')");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','user','owner',0)");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','bot','bot',0)");
}

test("right-click renames without switching chats, synchronizes and retains bindings; groups/topics support F2", async ({ page, browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rename-chat-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const observerContext = await browser.newContext(), observer = await observerContext.newPage();
  try {
    await seed(hub);
    const other = await hub.store.createConversation("owner", ["bot"], "正在编辑的对话", "other");
    const group = await hub.store.createConversation("owner", ["bot"], "研究群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["bot"], "研究话题", "topic", { type: "group", parentId: group.id });
    await pair(page, hub); await pair(observer, hub);
    await row(page, "正在编辑的对话").click();
    await workspace(page).getByLabel("消息", { exact: true }).fill("保留我的草稿");
    await row(page, "原名称").click({ button: "right" });
    await expect(page.getByRole("menu", { name: "对话操作" })).toBeVisible();
    await expect(row(page, "正在编辑的对话")).toHaveAttribute("aria-current", "page");
    await page.getByRole("menuitem", { name: "重命名" }).click();
    const input = page.getByLabel("对话名称", { exact: true });
    await expect(input).toBeFocused();
    expect(await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, 3]);
    await input.fill("  项目计划  ");
    // Pinyin confirmation must not submit the form, including WebKit's 229 key
    // after compositionend when isComposing has already become false.
    expect(await input.evaluate(node => [true, false].map(isComposing => node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", keyCode: 229, isComposing }))))).toEqual([false, false]);
    await expect(input).toBeVisible();
    expect((await hub.store.conversations("owner")).find(c => c.id === "same_chat")!.title).toBe("原名称");
    await input.press("Enter");
    await expect(page.getByRole("dialog", { name: "重命名对话", exact: true })).toHaveCount(0);
    await expect(row(page, "项目计划")).toBeVisible(); await expect(row(observer, "项目计划")).toBeVisible();
    await expect(row(page, "正在编辑的对话")).toHaveAttribute("aria-current", "page");
    await expect(workspace(page).getByLabel("消息", { exact: true })).toHaveValue("保留我的草稿");
    const saved = (await hub.store.conversations("owner")).find(c => c.id === "same_chat")!;
    expect(saved).toMatchObject({ title: "项目计划", sessionId: "existing_session", bindingId: "existing_binding", botIds: ["bot"] });
    expect((await hub.store.conversations("owner")).find(c => c.id === other.id)!.title).toBe("正在编辑的对话");
    for (const [before, after, id] of [["研究群", "产品讨论群", group.id], ["研究话题", "上线准备", topic.id]]) {
      await row(page, before!).focus(); await page.keyboard.press("F2");
      const field = page.getByLabel(id === topic.id ? "话题名称" : "对话名称", { exact: true });
      await field.fill(after!); await field.press("Enter");
      await expect(page.getByRole("dialog", { name: id === topic.id ? "重命名话题" : "重命名对话", exact: true })).toHaveCount(0);
      await expect(row(observer, after!)).toBeVisible();
      expect((await hub.store.conversations("owner")).find(c => c.id === id)!.title).toBe(after);
    }
    await row(page, "项目计划").focus(); await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "重命名" }).click();
    await input.fill("   "); await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await input.fill("取消的改动"); await page.keyboard.press("Escape");
    await expect(row(page, "项目计划")).toBeFocused();
    await page.reload(); await expect(row(page, "项目计划")).toBeVisible();
    expect((await hub.store.conversations("owner")).find(c => c.id === topic.id)!.parentId).toBe(group.id);
  } finally { await observerContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("context rename uses the clicked host even when another host has the same conversation ID", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rename-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    await seed(a); await seed(b); await pair(page, a, "主机甲"); await pair(page, b, "主机乙", true);
    await setListOption(page, '按主机分组', true);
    const target = workspace(page).getByRole("region", { name: "主机：主机甲", exact: true }).locator(".conversation-row");
    await target.click({ button: "right" }); await page.getByRole("menuitem", { name: "重命名" }).click();
    await expect(page.getByRole("dialog")).toContainText("运行于 主机甲");
    await page.getByLabel("对话名称", { exact: true }).fill("只改主机甲");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(target).toContainText("只改主机甲");
    expect((await a.store.conversations("owner"))[0]!.title).toBe("只改主机甲");
    expect((await b.store.conversations("owner"))[0]!.title).toBe("原名称");
    // A portalled menu must stay inside the viewport and disappear on resize.
    await target.dispatchEvent("contextmenu", { clientX: 1359, clientY: 899 });
    const menu = page.getByRole("menu", { name: "对话操作" }); await expect(menu).toBeVisible();
    const rect = (await menu.boundingBox())!; expect(rect.x + rect.width).toBeLessThanOrEqual(1360); expect(rect.y + rect.height).toBeLessThanOrEqual(900);
    await page.setViewportSize({ width: 1000, height: 740 }); await expect(menu).toHaveCount(0);
  } finally { await b.close(); await a.close(); await rm(root, { recursive: true, force: true }); }
});
