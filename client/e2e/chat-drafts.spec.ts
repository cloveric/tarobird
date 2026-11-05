import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction, revealReplyBots, dismissReplyBots } from "./fixtures/desktop-actions.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, waitForClientOnline, selectConversation, mobileChatAction, openMobileHome } from "./fixtures/mobile.js";
import { messageAction, holdMessage } from "./fixtures/message-actions.js";

test.use({ serviceWorkers: "block" });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page);
}
for (const phone of [false, true]) test(`conversation list previews unsent text, files and quotes (${phone ? "phone" : "desktop"})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "draft-list-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const one = await hub.store.createConversation("owner", ["alpha"], "草稿预览", "one");
    const two = await hub.store.createConversation("owner", ["alpha"], "另一段对话", "two");
    const group = await hub.store.createConversation("owner", ["alpha"], "项目讨论", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "预算话题", "topic", { parentId: group.id });
    const quoted = await hub.store.publishBotMessage("alpha", { conversationId: one.id, blocks: [{ type: "text", text: "已有回复" }], status: "complete" });
    await pair(page, hub); await selectConversation(page, one.title);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    const row = (id: string) => page.locator(`${phone ? ".mh-row" : ".conversation-row"}[data-conversation-id="${id}"]:visible`);
    await input.fill("是不是也在\n附件中心");
    await selectConversation(page, two.title); await openMobileHome(page);
    await expect(row(one.id)).toContainText("草稿：是不是也在 附件中心");
    await expect(row(two.id)).not.toContainText("草稿：");
    // A new reply must not hide the local unsent text or turn it into a message.
    await hub.store.publishBotMessage("alpha", { conversationId: one.id, blocks: [{ type: "text", text: "更新后的回复" }], status: "complete" });
    await page.reload(); await waitForClientOnline(page); await openMobileHome(page);
    await expect(row(one.id)).toContainText("草稿：是不是也在 附件中心");
    await row(one.id).screenshot({ path: info.outputPath("draft-preview.png") });
    await selectConversation(page, one.title);
    await expect(input).toHaveValue("是不是也在\n附件中心");
    await input.fill(""); await openMobileHome(page);
    await expect(row(one.id)).not.toContainText("草稿：");
    await expect(row(one.id)).toContainText("更新后的回复");

    await selectConversation(page, one.title);
    await page.locator("input.attachment-picker-input").setInputFiles({ name: "未发送.txt", mimeType: "text/plain", buffer: Buffer.from("draft bytes") });
    await expect(page.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
    await page.reload(); await waitForClientOnline(page); await openMobileHome(page);
    await expect(row(one.id)).toContainText("草稿：1 个附件");
    await selectConversation(page, one.title);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".attachment-draft")).toHaveCount(0); await openMobileHome(page);
    await expect(row(one.id)).not.toContainText("草稿：");
    await selectConversation(page, one.title);
    await messageAction(page, page.locator(`[data-message-id="${quoted.id}"]`), "引用回复");
    await openMobileHome(page);
    await expect(row(one.id)).toContainText("草稿：引用回复");
    await selectConversation(page, one.title);
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await openMobileHome(page);
    await expect(row(one.id)).not.toContainText("草稿：");
    expect((await hub.store.snapshot("owner", one.id)).messages.filter(message => message.authorType === "user")).toHaveLength(1);
    expect((await hub.store.snapshot("owner", two.id)).messages).toHaveLength(0);
    await selectConversation(page, topic.title, group.title);
    await input.fill("话题里写了一半"); await openMobileHome(page);
    if (phone) await expect(row(group.id)).toContainText("草稿：预算话题：话题里写了一半");
    else {
      await expect(row(topic.id)).toContainText("草稿：话题里写了一半");
      await page.getByRole("button", { name: "按对话", exact: true }).click();
      await expect(row(group.id)).toContainText("草稿：预算话题：话题里写了一半");
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`complete drafts stay with each conversation (${phone ? "phone" : "desktop"})`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chat-drafts-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手甲','fixture'),('beta','助手乙','fixture')");
    const one = await hub.store.createConversation("owner", ["alpha", "beta"], "方案讨论", "one", { type: "group" });
    const two = await hub.store.createConversation("owner", ["alpha"], "另一件事", "two");
    const quoted = await hub.store.publishBotMessage("alpha", { conversationId: one.id, blocks: [{ type: "text", text: "需要保留的引用原文" }] });
    await pair(page, hub); await selectConversation(page, one.title);
    await page.route("**/api/link-preview", route => route.fulfill({ status: 503, json: { error: "fixture" } }));
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("方案说明 https://example.invalid/reference");
    await page.getByRole("button", { name: "关闭链接预览", exact: true }).click();
    await messageAction(page, page.locator(`[data-message-id="${quoted.id}"]`), "引用回复");
    await page.locator("input.attachment-picker-input").setInputFiles([
      { name: "方案.txt", mimeType: "text/plain", buffer: Buffer.from("file bytes") },
      { name: "voice.webm", mimeType: "audio/webm", buffer: Buffer.from("recorded draft bytes") },
    ]);
    await revealReplyBots(page);
    // Current groups start without an explicit mention; set the intended
    // recipient instead of assuming the historical first-member default.
    await page.getByRole("checkbox", { name: "助手甲", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "助手乙", exact: true }).check();
    await selectConversation(page, two.title);
    await expect(page.locator(".attachment-draft")).toHaveCount(0);
    await expect(page.locator(".reply-preview")).toHaveCount(0);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("另一份独立草稿");
    await page.locator("input.attachment-picker-input").setInputFiles({ name: "另一份.txt", mimeType: "text/plain", buffer: Buffer.from("other draft") });
    await selectConversation(page, one.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("方案说明 https://example.invalid/reference");
    await expect(page.locator(".attachment-draft-file")).toHaveCount(2);
    await expect(page.locator(".reply-preview")).toContainText("需要保留的引用原文");
    await expect(page.getByRole("button", { name: "显示链接预览", exact: true })).toBeVisible();
    await revealReplyBots(page);
    await expect(page.getByRole("checkbox", { name: "助手甲", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("checkbox", { name: "助手乙", exact: true })).toHaveAttribute("aria-checked", "true");
    // The same complete draft must survive a process/page lifetime, not just
    // switching React state. Wait for the durable receipt before reloading.
    await expect(page.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, one.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("方案说明 https://example.invalid/reference");
    await expect(page.locator(".attachment-draft-file")).toHaveCount(2);
    await expect(page.locator(".reply-preview")).toContainText("需要保留的引用原文");
    await expect(page.getByRole("button", { name: "显示链接预览", exact: true })).toBeVisible();
    await revealReplyBots(page);
    await expect(page.getByRole("checkbox", { name: "助手乙", exact: true })).toHaveAttribute("aria-checked", "true");
    // Switching must not create a message or leak either conversation's files.
    expect((await hub.store.snapshot("owner", one.id)).messages).toHaveLength(1);
    expect((await hub.store.snapshot("owner", two.id)).messages).toHaveLength(0);
    await dismissReplyBots(page);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".attachment-draft")).toHaveCount(0);
    await expect(page.locator(".reply-preview")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    const sent = (await hub.store.snapshot("owner", one.id)).messages.find(m => m.authorType === "user")!;
    expect(sent.replyTo).toBe(quoted.id); expect(sent.mentions).toEqual(["beta"]); expect(sent.previewUrl).toBeNull();
    expect(sent.blocks.map(b => b.type)).toEqual(["text", "file", "audio"]);
    await selectConversation(page, two.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("另一份独立草稿");
    await expect(page.locator(".attachment-draft")).toContainText("另一份.txt");
    await selectConversation(page, one.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    await expect(page.locator(".attachment-draft")).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
for (const phone of [false, true]) test(`archived parent blocks message retry in its topic (${phone ? "phone" : "desktop"})`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archived-retry-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const group = await hub.store.createConversation("owner", ["alpha"], "已归档群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "仍可阅读的话题", "topic", { parentId: group.id });
    const { message } = await hub.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "seed", text: "历史消息", attachments: [] });
    await hub.store.updateConversation("owner", group.id, { archived: true });
    await pair(page, hub);
    await page.evaluate(id => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail: { conversationId: id } })), topic.id);
    await expect(page.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
    const row = page.locator(`[data-message-id="${message.id}"]`);
    if (phone) await holdMessage(page, row); else await row.hover();
    const retry = page.getByRole("button", { name: "重新发送消息", exact: true });
    await expect(retry).toBeDisabled();
    if (phone) await expect(page.getByText("对话已归档，恢复后可重新发送。", { exact: true })).toBeVisible();
    await retry.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator(".queued-message")).toHaveCount(0);
    expect((await hub.store.snapshot("owner", topic.id)).messages).toHaveLength(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`real Hub mute receipt survives reread failure and normalized rename closes cleanly (${phone ? "phone" : "desktop"})`, async ({ page }) => {
 if (phone) await page.setViewportSize({width:390,height:844});
 const root=await mkdtemp(path.join(os.tmpdir(),"conversation-receipt-"));
 const hub=await HubServer.start({stateDir:root,clientDir:path.resolve("dist")});
 try {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
  const conversation=await hub.store.createConversation("owner",['alpha'],'设置验收','receipt');
  await pair(page,hub);
  if (phone) { await selectConversation(page,conversation.title); await mobileChatAction(page,'对话设置'); }
  else await clickAppAction(page, '对话设置', page.getByRole('button',{name:'对话设置',exact:true}));
  // Opening the phone sheet is asynchronous; verify the committed layout,
  // retaining the same alignment and minimum target-size requirements.
  await expect(page.locator('.conversation-settings label.settings-row')).toHaveCount(2);
  await expect.poll(() => page.locator('.conversation-settings label.settings-row').evaluateAll(rows => rows.length === 2 && rows.every(row => {const a=row.querySelector('span')!.getBoundingClientRect(),b=row.querySelector('input')!.getBoundingClientRect();return b.left > a.right && Math.abs(a.top+a.height/2-b.top-b.height/2)<2 && row.getBoundingClientRect().height>=44;}))).toBe(true);
  await expect(page.getByLabel('此对话免打扰',{exact:true})).toBeEnabled();
  await page.route('**/api/notifications',route=>route.fulfill({status:503,json:{error:'fixture_read_failure'}}));
  await page.getByLabel('此对话免打扰',{exact:true}).click();
  await expect(page.getByLabel('此对话免打扰',{exact:true})).toBeChecked();
  await expect.poll(async()=>(await hub.store.db.get<{muted:number}>("SELECT muted FROM conversation_members WHERE conversation_id=? AND member_type='user'",[conversation.id]))?.muted).toBe(1);
  await expect(page.getByText('通知设置暂时无法刷新，已保存的修改仍然有效。',{exact:true})).toBeVisible();
  await page.getByLabel('对话名称',{exact:true}).fill('已保存名称  ');
  await page.getByRole('button',{name:'保存名称',exact:true}).click();
  await expect(page.getByLabel('对话名称',{exact:true})).toHaveValue('已保存名称');
  await page.getByRole('button',{name:'关闭对话设置',exact:true}).click();
  if (phone) {
    const details = page.getByRole('dialog', { name: '对话详情', exact: true });
    await expect(details).toBeVisible();
    await details.getByRole('button', { name: '返回聊天', exact: true }).click();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (phone) await expect(page.getByRole('button',{name:'查看对话详情',exact:true})).toBeFocused();
 } finally {await page.close();await hub.close();await rm(root,{recursive:true,force:true});}
});
