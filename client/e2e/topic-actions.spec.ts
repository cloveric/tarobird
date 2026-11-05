import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
const directory = (page: Page) => page.getByRole("dialog", { name: "群内话题", exact: true });
const actions = (page: Page) => page.getByRole("dialog", { name: "话题操作", exact: true });
const removal = (page: Page) => page.getByRole("dialog", { name: "删除话题", exact: true });
const title = (page: Page, name: string) => page.getByRole("heading", { name, level: 1, exact: true });
const composer = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });

for (const width of [390, 320]) test(`topic rename and recoverable deletion target one topic across devices (${width}px)`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topic-actions-"));
  let hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const mobile = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true });
  const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phone = await mobile.newPage(), observer = await desktop.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','话题助手','fixture')");
    const group = await hub.store.createConversation("owner", ["bot"], "开心乐园", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "开心乐园", "topic", { parentId: group.id });
    const sibling = await hub.store.createConversation("owner", [], "节目安排", "sibling", { parentId: group.id });
    await hub.store.publishBotMessage("bot", { conversationId: topic.id, blocks: [{ type: "text", text: "这个话题的历史需要保留" }] });
    await hub.store.db.run("UPDATE conversations SET session_id='preserved-session',binding_id='preserved-binding' WHERE id=?", [topic.id]);
    for (const page of [phone, observer]) await pair(page, hub);
    await selectConversation(phone, group.title);
    await composer(phone).fill("群组草稿");
    await phone.getByRole("navigation", { name: "群组话题", exact: true }).getByRole("button").filter({ has: phone.getByText(topic.title, { exact: true }) }).click();
    await observer.locator(".conversation-row.topic-row").filter({ has: observer.getByText(topic.title, { exact: true }) }).click();
    await composer(phone).fill("这个话题的草稿");
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await phone.getByRole("button", { name: "重命名话题", exact: true }).click();
    const rename = phone.getByRole("dialog", { name: "重命名话题", exact: true });
    await rename.getByLabel("话题名称", { exact: true }).fill("周末活动");
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(title(phone, "周末活动")).toBeVisible(); await expect(title(observer, "周末活动")).toBeVisible();
    await expect(composer(phone)).toHaveValue("这个话题的草稿");
    expect((await hub.store.conversations("owner")).find(c => c.id === group.id)!.title).toBe("开心乐园");

    await phone.getByRole("button", { name: "全部话题", exact: true }).click();
    const manageSibling = directory(phone).getByRole("button", { name: "管理话题「节目安排」", exact: true });
    const bounds = (await manageSibling.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
    await manageSibling.click(); await expect(actions(phone)).toBeVisible();
    expect(await phone.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(actions(phone)).toHaveCount(0); await expect(manageSibling).toBeFocused();
    await manageSibling.click(); await actions(phone).getByRole("button", { name: "重命名话题", exact: true }).click();
    await rename.getByLabel("话题名称", { exact: true }).fill("活动安排"); await rename.getByRole("button", { name: "保存", exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(directory(phone).getByRole("button", { name: "管理话题「活动安排」", exact: true })).toBeFocused();
    await phone.screenshot({ path: info.outputPath(`topic-directory-${width}.png`), animations: "disabled" });
    await directory(phone).getByRole("button", { name: "管理话题「活动安排」", exact: true }).click();
    await actions(phone).getByRole("button", { name: "删除话题", exact: true }).click();
    await expect(removal(phone)).toContainText("从所有设备移除此话题，群组和其他话题不受影响。");
    await removal(phone).getByRole("button", { name: "取消", exact: true }).click();
    expect((await hub.store.conversations("owner")).find(c => c.id === sibling.id)!.archived).toBe(false);
    await directory(phone).getByRole("button", { name: "管理话题「活动安排」", exact: true }).click();
    await actions(phone).getByRole("button", { name: "删除话题", exact: true }).click();
    await removal(phone).getByRole("button", { name: "删除话题", exact: true }).click();
    await expect(removal(phone)).toHaveCount(0);
    await expect(directory(phone).getByRole("button", { name: "管理话题「活动安排」", exact: true })).toHaveCount(0);
    await directory(phone).getByRole("button", { name: "关闭话题列表", exact: true }).click();
    await expect(title(phone, "周末活动")).toBeVisible(); await expect(composer(phone)).toHaveValue("这个话题的草稿");

    // Stop the actual transport: WebKit's offline emulation can leave existing
    // WebSockets open, so it does not establish a disconnected Hub.
    const port = Number(new URL(hub.url).port); await hub.close();
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await expect(phone.getByRole("button", { name: "重命名话题", exact: true })).toBeDisabled();
    await expect(phone.getByRole("button", { name: "删除话题", exact: true })).toBeDisabled();
    await phone.keyboard.press("Escape");
    hub = await HubServer.start({ stateDir: root, port, clientDir: path.resolve("dist") });
    await waitForClientOnline(phone); await waitForClientOnline(observer);
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await phone.getByRole("button", { name: "删除话题", exact: true }).click();
    await phone.screenshot({ path: info.outputPath(`topic-delete-${width}.png`), animations: "disabled" });
    await removal(phone).getByRole("button", { name: "删除话题", exact: true }).click();
    await expect(removal(phone)).toHaveCount(0); await expect(title(phone, group.title)).toBeVisible();
    await expect(composer(phone)).toHaveValue("群组草稿");
    await expect(observer.locator(".archived-notice")).toBeVisible();
    const saved = (await hub.store.conversations("owner")).find(c => c.id === topic.id)!;
    expect(saved).toMatchObject({ archived: true, title: "周末活动", parentId: group.id, sessionId: "preserved-session", bindingId: "preserved-binding" });
    expect((await hub.store.conversations("owner")).find(c => c.id === group.id)!.archived).toBe(false);
    expect((await hub.store.snapshot("owner", topic.id)).messages).toHaveLength(1);

    await phone.getByRole("button", { name: "全部话题", exact: true }).click();
    await directory(phone).getByRole("button", { name: "已归档", exact: true }).click();
    await directory(phone).locator(".topic-directory-row").filter({ hasText: "周末活动" }).click();
    await expect(phone.locator(".message-blocks")).toContainText("这个话题的历史需要保留");
    await phone.getByRole("button", { name: "管理话题", exact: true }).click();
    await phone.getByRole("button", { name: "恢复到会话列表", exact: true }).click();
    await expect(composer(phone)).toHaveValue("这个话题的草稿"); await expect(composer(observer)).toBeVisible();
    // Desktop current-topic menu is equally explicit and stays scoped to the topic.
    await observer.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await observer.getByRole("button", { name: "删除话题", exact: true }).click();
    await expect(removal(observer)).toContainText("周末活动"); await observer.keyboard.press("Escape");
    expect((await hub.store.conversations("owner")).find(c => c.id === topic.id)!.archived).toBe(false);
    // Deleting the current topic from the directory also returns to its group.
    await phone.getByRole("button", { name: "全部话题", exact: true }).click();
    await directory(phone).getByRole("button", { name: "管理话题「周末活动」", exact: true }).click();
    await actions(phone).getByRole("button", { name: "删除话题", exact: true }).click();
    await removal(phone).getByRole("button", { name: "删除话题", exact: true }).click();
    await expect(directory(phone)).toHaveCount(0); await expect(title(phone, group.title)).toBeVisible();
    await expect(composer(phone)).toHaveValue("群组草稿");
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await mobile.close(); await desktop.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a delayed topic deletion does not override a newer notification navigation", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topic-delete-navigation-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release = () => {};
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','话题助手','fixture')");
    const group = await hub.store.createConversation("owner", ["bot"], "项目群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "待删除话题", "topic", { parentId: group.id });
    const next = await hub.store.createConversation("owner", [], "新通知话题", "next", { parentId: group.id });
    await page.setViewportSize({ width: 390, height: 844 }); await pair(page, hub);
    await selectConversation(page, topic.title, group.title);
    const update = hub.store.updateConversation.bind(hub.store);
    let held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    hub.store.updateConversation = async (...args) => {
      if (args[1] === topic.id && args[2].archived) { held = true; await gate; }
      return update(...args);
    };
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "删除话题", exact: true }).click();
    await removal(page).getByRole("button", { name: "删除话题", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await page.evaluate(conversationId => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail: { conversationId } })), next.id);
    // The busy modal still exists, so inspect its underlying heading directly.
    await expect(page.locator("h1[aria-label]")).toHaveAttribute("aria-label", next.title);
    release(); await expect(removal(page)).toHaveCount(0);
    await expect(title(page, next.title)).toBeVisible();
    await composer(page).fill("新话题草稿");
    expect((await hub.store.conversations("owner")).find(c => c.id === topic.id)!.archived).toBe(true);
    expect((await hub.store.conversations("owner")).find(c => c.id === next.id)!.archived).toBe(false);
    await expect(composer(page)).toHaveValue("新话题草稿");
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
