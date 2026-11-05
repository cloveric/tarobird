import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { enterMobileChat } from "./fixtures/mobile.js";
import { openSettings } from "./fixtures/settings.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";

test("each device reopens its own group or topic while navigation targets override the saved selection", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topic-selection-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext();
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','位置验收助手',?)", [hashSecret("selection-fixture")]);
    const group = await hub.store.createConversation("owner", ["alpha"], "本机继续讨论", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "手机独立话题", "topic", { parentId: group.id });
    // Deterministic creation order also verifies the first-open fallback.
    await hub.store.db.run("UPDATE conversations SET created_at=? WHERE id=?", [group.createdAt + 1000, topic.id]);
    for (const page of [desktop, phone]) {
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      if (page === phone) { await enterMobileChat(phone, group.title); await phone.getByRole("navigation", { name: "群组话题", exact: true }).getByRole("button", { name: topic.title, exact: true }).click(); }
      await expect(page.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
    }
    await desktop.getByRole("button", { name: `返回群组「${group.title}」`, exact: true }).click();
    await expect(desktop.getByRole("heading", { name: group.title, exact: true })).toBeVisible();
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("电脑草稿");
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("手机草稿");
    const saved = async (page: typeof desktop) => page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open("tarocub-v1"); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const request = open.result.transaction("settings").objectStore("settings").get("selectedConversation"); request.onerror = () => reject(request.error); request.onsuccess = () => { resolve(request.result ?? null); open.result.close(); }; };
    }));
    await expect.poll(() => saved(desktop)).toBe(group.id);
    await expect.poll(() => saved(phone)).toBe(topic.id);
    for (const [page, title, draft] of [[desktop, group.title, "电脑草稿"], [phone, topic.title, "手机草稿"]] as const) {
      await page.reload(); await expect(page.locator(".connection-pill.online")).toHaveCount(1);
      if (page === phone) { await enterMobileChat(phone, group.title); await phone.getByRole("navigation", { name: "群组话题", exact: true }).getByRole("button", { name: topic.title, exact: true }).click(); }
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(draft);
    }
    // New shared content does not change another device's local page.
    await hub.store.publishBotMessage("alpha", { conversationId: group.id, blocks: [{ type: "text", text: "桌面继续收到消息" }] });
    await expect(desktop.locator(".message-blocks")).toContainText("桌面继续收到消息");
    await expect(phone.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
    await desktop.evaluate((conversationId) => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail: { conversationId } })), topic.id);
    await expect(desktop.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
    await desktop.reload(); await expect(desktop.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
    // Forgetting this device clears the selection with the rest of its Hub state.
    await desktop.getByRole("button", { name: `返回群组「${group.title}」`, exact: true }).click();
    await openSettings(desktop);
    await desktop.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^网络与连接/ }).click();
    await desktop.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: /^此设备的连接/ }).click();
    await desktop.getByRole("button", { name: "从此设备移除", exact: true }).click();
    await desktop.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(desktop.locator(".host-manager-row")).toHaveCount(0); await desktop.keyboard.press("Escape");
    await expect(desktop.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible();
    expect(await saved(desktop)).toBeNull();
    await expect(phone.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
  } finally { await Promise.allSettled([desktopContext.close(), phoneContext.close()]); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group topics stay organized, searchable and recoverable on desktop and phone", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topic-navigation-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手',?)", [hashSecret("topic-fixture")]);
    const group = await hub.store.createConversation("owner", ["alpha"], "产品研发工作群", "group", { type: "group" });
    const titles = ["产品需求", "界面设计", "文件传输", "手机适配", "性能优化", "设备同步", "用户反馈", "发布准备"];
    const topics = [];
    for (const [index, title] of titles.entries()) topics.push(await hub.store.createConversation("owner", [], title, `topic_${index}`, { parentId: group.id }));
    await hub.store.publishBotMessage("alpha", { conversationId: topics[1]!.id, blocks: [{ type: "text", text: "设计方案等待讨论" }] });
    await hub.store.updateConversation("owner", topics[7]!.id, { archived: true });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    // This history/navigation fixture has no Gateway, including its direct chat.
    await showDisconnectedBots(page);
    await page.locator(".conversation-row").filter({ has: page.getByText(group.title, { exact: true }) }).click();
    await page.getByRole("button", { name: `收起「${group.title}」的话题`, exact: true }).click();
    await expect(page.locator(".topic-row")).toHaveCount(0);
    await page.getByRole("button", { name: `展开「${group.title}」的话题`, exact: true }).click();
    await expect(page.locator(".topic-row")).toHaveCount(7);
    await clickAppAction(page, "全部话题", page.getByRole("button", { name: "全部话题", exact: true }));
    let directory = page.getByRole("dialog", { name: "群内话题", exact: true });
    await expect(directory.getByText(group.title, { exact: true })).toBeVisible();
    await directory.getByRole("textbox", { name: "搜索群内话题", exact: true }).fill("设计");
    await expect(directory.locator(".topic-directory-row")).toHaveCount(1);
    await expect(directory.getByText("设计方案等待讨论", { exact: true })).toBeVisible();
    await directory.locator(".topic-directory-row").click();
    await expect(page.getByRole("heading", { name: "界面设计", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `返回群组「${group.title}」`, exact: true })).toBeVisible();
    await expect(page.locator(".message-body").getByText("设计方案等待讨论", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("设计话题草稿");
    await clickAppAction(page, "新建话题", page.getByRole("button", { name: "新建话题", exact: true }));
    await page.getByPlaceholder("为这段对话起个名字").fill("独立的登录流程"); await page.getByRole("button", { name: "创建话题", exact: true }).click();
    await expect(page.getByRole("heading", { name: "独立的登录流程", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    await expect(page.locator(".message-body").getByText("设计方案等待讨论", { exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("只发送到登录话题"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-body").getByText("只发送到登录话题", { exact: true })).toBeVisible();
    await clickAppAction(page, "全部话题", page.getByRole("button", { name: "全部话题", exact: true }));
    directory = page.getByRole("dialog", { name: "群内话题", exact: true });
    await directory.getByRole("textbox", { name: "搜索群内话题", exact: true }).fill("界面设计"); await directory.locator(".topic-directory-row").click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("设计话题草稿");
    await expect(page.locator(".message-body").getByText("只发送到登录话题", { exact: true })).toHaveCount(0);
    // Header controls must not accumulate across group/topic/direct switches.
    const direct = await hub.store.createConversation("owner", ["alpha"], "独立私聊", "header-direct");
    await page.reload(); await waitForClientOnline(page);
    for (const target of [group, topics[1]!, direct, group, direct, topics[1]!]) {
      await page.locator(".conversation-row").filter({ has: page.getByText(target.title, { exact: true }) }).click();
      await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
      await expect(page.locator(".header-topic")).toHaveCount(target.id === direct.id ? 0 : 1);
      await expect(page.getByRole("button", { name: "查看对话详情", exact: true })).toHaveCount(1);
    }
    await page.screenshot({ path: info.outputPath("group-topics-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".sidebar")).not.toBeInViewport();
    await expect(page.getByRole("button", { name: `返回群组「${group.title}」`, exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "新建话题", exact: true })).toBeInViewport();
    await clickAppAction(page, "全部话题", page.getByRole("button", { name: "全部话题", exact: true }));
    directory = page.getByRole("dialog", { name: "群内话题", exact: true });
    await expect(directory.locator(".topic-directory-row")).toHaveCount(8);
    await page.screenshot({ path: info.outputPath("group-topics-phone-active.png"), fullPage: true });
    await page.keyboard.press("Escape"); await expect(directory).toHaveCount(0);
    await expect(page.getByRole("button", { name: "全部话题", exact: true })).toBeFocused();
    await clickAppAction(page, "全部话题", page.getByRole("button", { name: "全部话题", exact: true }));
    await directory.getByRole("button", { name: "已归档", exact: true }).click();
    await expect(directory.locator(".topic-directory-row")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("group-topics-phone-directory.png"), fullPage: true });
    await directory.locator(".topic-directory-row").click();
    await expect(page.getByRole("heading", { name: "发布准备", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "管理话题", exact: true }).click(); await page.getByRole("button", { name: "恢复到会话列表", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
    await page.getByRole("button", { name: `返回群组「${group.title}」`, exact: true }).click();
    await expect(page.getByRole("heading", { name: group.title, exact: true })).toBeVisible();
    await expect(page.locator(".message-body").getByText("只发送到登录话题", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("group-topics-phone.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const saved = (await hub.store.conversations("owner")).find((c) => c.title === "独立的登录流程")!;
    expect(saved.parentId).toBe(group.id); expect((await hub.store.snapshot("owner", saved.id)).messages).toHaveLength(1);
    expect((await hub.store.snapshot("owner", group.id)).messages).toHaveLength(0);
    expect((await hub.store.snapshot("owner", topics[1]!.id)).messages).toHaveLength(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
