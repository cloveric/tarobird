import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { HubServer } from "../../src/hub/server.js";
import { avatarFixture } from "../../tests/helpers/avatar-fixture.js";
import { defaultBotAvatar } from "../src/bot-avatar-catalog.js";
import { showDisconnectedBots, mobileHome, openMobileHome, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ actionTimeout: 15_000 });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
const editor = (page: Page) => page.getByRole("dialog", { name: "编辑对话头像", exact: true });
const desktopRow = (page: Page, id: string) => page.locator(`.conversation-row[data-conversation-id="${id}"]`).filter({ visible: true });
const phoneRow = (page: Page, id: string) => mobileHome(page).locator(`.mh-row[data-conversation-id="${id}"]`);
async function customImage(row: Locator, id: string) {
  const image = row.locator(`[data-avatar="group:${id}"] > img`);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(256);
}
async function desktopEdit(page: Page, id: string) {
  await desktopRow(page, id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "设置对话头像", exact: true }).click();
  await expect(editor(page)).toBeVisible();
}
async function save(page: Page) {
  await editor(page).getByRole("button", { name: "保存头像", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
}

test("independent conversation avatars sync from phone and desktop without changing Bot authors or sibling chats", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conversation-avatars-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const dc = await browser.newContext(), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const desktop = await dc.newPage(), phone = await pc.newPage();
  const errors: string[] = []; for (const page of [desktop, phone]) page.on("pageerror", e => errors.push(e.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','精灵助手','fixture')");
    const first = await hub.store.createConversation("owner", ["alpha"], "旅行计划", "first");
    const second = await hub.store.createConversation("owner", ["alpha"], "工作笔记", "second");
    await hub.store.publishBotMessage("alpha", { conversationId: first.id, blocks: [{ type: "text", text: "我仍然使用自己的 Bot 头像。" }] });
    await pair(desktop, hub); await pair(phone, hub);
    await desktop.getByRole("button", { name: "按对话", exact: true }).click();
    // Native-style hold opens the phone action sheet without selecting the chat.
    const row = phoneRow(phone, first.id);
    if (info.project.use.browserName !== "webkit") {
      const cdp = await pc.newCDPSession(phone), box = (await row.boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 100, y: box.y + 30 }] });
      await expect(phone.getByRole("dialog", { name: "对话操作", exact: true })).toBeVisible();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
    } else {
      await row.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: 130, clientY: 270 });
      await expect(phone.getByRole("dialog", { name: "对话操作", exact: true })).toBeVisible();
      await row.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0 });
    }
    await phone.getByRole("button", { name: "设置对话头像", exact: true }).tap();
    await expect(editor(phone)).toContainText("只更改此对话的头像，不影响 Bot 头像。");
    await editor(phone).getByRole("button", { name: "上传图片", exact: true }).tap();
    await phone.getByLabel("选择头像图片", { exact: true }).setInputFiles({ name: "trip.png", mimeType: "image/png", buffer: avatarFixture(400, 300, 90) });
    await expect(phone.getByLabel("头像裁剪预览")).toBeVisible();
    await phone.screenshot({ path: info.outputPath("conversation-avatar-phone-editor.png") }); await save(phone);
    await customImage(phoneRow(phone, first.id), first.id); await customImage(desktopRow(desktop, first.id), first.id);
    await expect(desktopRow(desktop, second.id).locator('[data-avatar="bot:alpha"]')).toHaveAttribute("data-preset", defaultBotAvatar("alpha").id);
    await selectConversation(phone, first.title);
    await customImage(phone.getByRole("button", { name: "查看对话详情", exact: true }), first.id);
    await expect(phone.locator('.message-avatar.bot [data-avatar="bot:alpha"]')).toHaveAttribute("data-preset", defaultBotAvatar("alpha").id);
    await selectConversation(desktop, first.title);
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("未发送的旅行草稿");
    await desktopEdit(desktop, second.id);
    await editor(desktop).getByRole("button", { name: "选择橘猫头像", exact: true }).click();
    await save(desktop);
    await expect(desktop.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("未发送的旅行草稿");
    await openMobileHome(phone); await customImage(phoneRow(phone, second.id), second.id);
    await expect(phoneRow(phone, second.id).locator(".profile-avatar-conversation")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await phone.screenshot({ path: info.outputPath("conversation-avatar-phone-list.png") });
    await desktop.screenshot({ path: info.outputPath("conversation-avatar-desktop-list.png") });
    // Restoration falls back to the Bot and leaves the second chat's picture intact.
    await selectConversation(phone, first.title);
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("手机里还没发出的草稿");
    await phone.getByRole("button", { name: "查看对话详情", exact: true }).tap();
    const details = phone.getByRole("dialog", { name: "对话详情", exact: true });
    const avatarAction = details.getByRole("button", { name: "设置对话头像", exact: true });
    await expect(avatarAction).toBeInViewport();
    await expect(avatarAction).toHaveAccessibleDescription("只改此对话，不影响 Bot 头像");
    await phone.screenshot({ path: info.outputPath("conversation-avatar-details-entry.png"), animations: "disabled" });
    await avatarAction.tap();
    await editor(phone).getByRole("button", { name: "取消", exact: true }).tap();
    await expect(avatarAction).toBeFocused();
    await avatarAction.tap();
    phone.once("dialog", dialog => dialog.accept());
    await editor(phone).getByRole("button", { name: "恢复默认头像", exact: true }).click(); await expect(editor(phone)).toHaveCount(0);
    await expect(avatarAction).toBeFocused();
    await details.getByRole("button", { name: "返回聊天", exact: true }).tap();
    await expect(phone.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("手机里还没发出的草稿");
    await expect(desktopRow(desktop, first.id).locator('[data-avatar="bot:alpha"]')).toHaveAttribute("data-preset", defaultBotAvatar("alpha").id);
    await customImage(desktopRow(desktop, second.id), second.id);
    await desktop.reload(); await waitForClientOnline(desktop); await customImage(desktopRow(desktop, second.id), second.id);
    await desktop.getByRole("button", { name: "按 Bot", exact: true }).click();
    await desktopRow(desktop, second.id).click({ button: "right" });
    await expect(desktop.getByRole("menuitem", { name: "设置对话头像", exact: true })).toHaveCount(0);
    await desktop.keyboard.press("Escape");
    await desktop.getByRole("button", { name: "按对话", exact: true }).click();
    // The next reload deliberately stops the Hub; wait for this device-local
    // layout write as well as the already-persisted offline-Bot preference.
    await expect.poll(() => desktop.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<string | undefined>((resolve, reject) => { const request = db.transaction('meta').objectStore('meta').get('preferences'); request.onsuccess = () => resolve(request.result && JSON.parse(request.result).sidebarLayout); request.onerror = () => reject(request.error); }); }
      finally { db.close(); }
    })).toBe('conversations');
    await desktop.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => desktop.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await hub.close(); await desktop.reload({ waitUntil: "domcontentloaded" }); await customImage(desktopRow(desktop, second.id), second.id);
    expect(errors).toEqual([]);
  } finally { await dc.close(); await pc.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a missing conversation avatar editor can close without losing the active chat or draft", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conversation-avatar-recovery-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "草稿保留", "draft");
    await pair(page, hub); await page.getByRole("button", { name: "按对话", exact: true }).click();
    await selectConversation(page, chat.title);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("不能丢失的草稿");
    await page.route("**/AvatarEditorDialog-*.js", route => route.abort());
    await desktopEdit(page, chat.id);
    await expect(editor(page).getByRole("alert")).toContainText("头像编辑暂不可用");
    await page.getByRole("button", { name: "关闭头像编辑", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("不能丢失的草稿");
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("conversation avatar menus resolve the clicked host with equal conversation IDs on desktop and phone", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conversation-avatar-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const context = await browser.newContext({ serviceWorkers: "block", hasTouch: true }), page = await context.newPage();
  try {
    for (const [hub, name] of [[a, "主机甲"], [b, "主机乙"]] as const) {
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同名助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_chat','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','user','owner',0),('same_chat','bot','alpha',0)");
    }
    await pair(page, a); await clickAppAction(page, "连接另一台主机");
    await page.getByLabel("主机名称", { exact: true }).fill("主机乙"); await page.getByLabel("Hub 地址", { exact: true }).fill(b.url);
    await preparePairing(page, b); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await b.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
    const workspace = page.locator('.host-workspace:not([hidden])');
    await workspace.getByRole("button", { name: "按对话", exact: true }).click();
    await setListOption(page, '按主机分组', true);
    const first = workspace.getByRole("region", { name: "主机：主机甲", exact: true }).locator('.conversation-row[data-conversation-id="same_chat"]');
    const second = workspace.getByRole("region", { name: "主机：主机乙", exact: true }).locator('.conversation-row[data-conversation-id="same_chat"]');
    await first.click({ button: "right" }); await page.getByRole("menuitem", { name: "设置对话头像", exact: true }).click();
    await expect(editor(page)).toContainText("运行于 主机甲");
    await editor(page).getByRole("button", { name: "选择橘猫头像", exact: true }).click(); await save(page);
    await customImage(first, "same_chat"); await expect(second.locator('[data-avatar="bot:alpha"]')).toBeVisible();
    expect(await new HubAvatars(b.store).list("owner")).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    const groupedRow = (name: string) => mobileHome(page).locator('.mh-folder-host').filter({ has: page.getByRole('heading', { name, exact: true }) }).locator('.mh-row[data-conversation-id="same_chat"]');
    const phoneA = groupedRow("主机甲"), phoneB = groupedRow("主机乙");
    await phoneB.dispatchEvent("contextmenu"); await page.getByRole("button", { name: "设置对话头像", exact: true }).click();
    await expect(editor(page)).toContainText("运行于 主机乙");
    await editor(page).getByRole("button", { name: "选择紫芋头像", exact: true }).click(); await save(page);
    await customImage(phoneA, "same_chat"); await customImage(phoneB, "same_chat");
    const target = { kind: "group", id: "same_chat" } as const;
    const pa = await new HubAvatars(a.store).image("owner", target, 1), pb = await new HubAvatars(b.store).image("owner", target, 1);
    expect(pa.equals(pb)).toBe(false);
    // Both are revision 1 and share the same ID, so compare actual pixels to
    // catch a cache key accidentally shared between host identities.
    const pixel = (row: Locator) => row.locator('[data-avatar="group:same_chat"] > img').evaluate(node => {
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const ctx = c.getContext("2d")!; ctx.drawImage(node as HTMLImageElement, 0, 0); return c.toDataURL();
    });
    expect(await pixel(phoneA)).not.toBe(await pixel(phoneB));
  } finally { await context.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("older hosts keep direct conversation avatar editing disabled without affecting normal chat", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conversation-avatar-legacy-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "旧主机对话", "legacy");
    await page.routeWebSocket("**/ws", socket => {
      const upstream = socket.connectToServer();
      upstream.onMessage(data => {
        const frame = JSON.parse(String(data));
        if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== "conversation-avatars.v1");
        socket.send(JSON.stringify(frame));
      });
    });
    await pair(page, hub); await page.getByRole("button", { name: "按对话", exact: true }).click();
    await desktopRow(page, chat.id).click({ button: "right" });
    const action = page.getByRole("menuitem", { name: "设置对话头像", exact: true });
    await expect(action).toBeDisabled(); await expect(action).toHaveAttribute("title", "升级此主机后即可设置对话头像");
    await page.keyboard.press("Escape"); await selectConversation(page, chat.title);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("仍能正常聊天");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    const details = page.getByRole("dialog", { name: "对话详情", exact: true });
    const shortcut = details.getByRole("button", { name: "设置对话头像", exact: true });
    await expect(shortcut).toBeVisible();
    await expect(shortcut).toBeDisabled();
    await expect(shortcut).toHaveAccessibleDescription("升级此主机后即可设置对话头像");
    await details.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("仍能正常聊天");
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
