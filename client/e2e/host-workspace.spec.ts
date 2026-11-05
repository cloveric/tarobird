import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { holdMessage } from "./fixtures/message-actions.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { microphone } from "./fixtures/microphone.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";

test.use({ serviceWorkers: "block" });
const visible = (page: Page) => page.locator('.host-workspace:not([hidden])');
async function pair(page: Page, hub: HubServer, name: string, add = false) {
  // The authoritative name belongs to the host, not to this device's pairing alias.
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
  if (add) await clickAppAction(page, "连接另一台主机", visible(page).getByRole("button", { name: "连接另一台主机", exact: true })); else await page.goto(hub.url);
  await page.getByRole("textbox", { name: "主机名称", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(visible(page).locator(".connection-pill.online")).toBeVisible();
  await expect(visible(page)).toHaveAttribute("data-active-host", `hub_${createHash("sha256").update(Buffer.from(hub.auth.publicKey, "base64")).digest("hex")}`);
  await showDisconnectedBots(page);
  if (add && (page.viewportSize()?.width ?? 1360) > 760) await setListOption(page, '按主机分组', true);
}
async function choose(page: Page, name: string) {
  if (await visible(page).getByRole("button", { name: "打开会话列表", exact: true }).isVisible()) await visible(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
  // This journey enables host grouping on desktop; the same preference carries
  // into mobile, where the source name appears once in the section heading.
  if ((page.viewportSize()?.width ?? 1360) <= 760) await visible(page).locator('.mobile-home .mh-folder-host').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button').filter({ hasText:'同名对话' }).click();
  else await visible(page).getByRole("region", { name: `主机：${name}`, exact: true }).getByRole("button", { name: /^同名对话/ }).click();
  await expect(visible(page).locator(".runtime-host-label").first()).toHaveText(`运行于 ${name}`);
}
test("normal App pairs two hosts, isolates same IDs and drafts, retains uploads while switching and routes notifications explicitly", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-workspace-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const sockets = new Map<string, number>(); page.on("websocket", (socket) => sockets.set(socket.url(), (sockets.get(socket.url()) ?? 0) + 1));
  let releaseUpload: () => void = () => undefined;
  try {
    for (const [hub, prefix] of [[a, "A"], [b, "B"]] as const) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同名助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_conversation','direct','同名对话','owner',1,'same_action')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_conversation','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_conversation','bot','alpha',0)");
      await hub.store.publishBotMessage("alpha", { id: "same_message", conversationId: "same_conversation", blocks: [{ type: "text", text: `${prefix} 主机原文` }], status: "complete" });
    }
    await microphone(page);
    await pair(page, a, "Mac mini");
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("A 留下的草稿");
    await pair(page, b, "笔记本", true);
    await expect(visible(page).locator(".message-blocks")).toContainText("B 主机原文");
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("B 留下的草稿");
    await choose(page, "Mac mini"); await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("A 留下的草稿");
    await expect(visible(page).locator(".message-blocks")).not.toContainText("B 主机原文");
    const socketCount = [...sockets.values()].reduce((sum, n) => sum + n, 0);
    await choose(page, "笔记本"); await choose(page, "Mac mini");
    expect([...sockets.values()].reduce((sum, n) => sum + n, 0)).toBe(socketCount);
    // A delayed upload must finish on A while B remains writable.
    let held = false; const barrier = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const upload = a.attachments.putChunk.bind(a.attachments);
    a.attachments.putChunk = async (...args) => { held = true; await barrier; return upload(...args); };
    await visible(page).locator('input[type="file"][multiple]').setInputFiles({ name: "A-only.txt", mimeType: "text/plain", buffer: Buffer.from("A private attachment") });
    await visible(page).getByRole("button", { name: "发送消息", exact: true }).click(); await expect.poll(() => held).toBe(true);
    await choose(page, "笔记本"); await visible(page).getByRole("button", { name: "发送消息", exact: true }).click(); releaseUpload();
    await expect.poll(async () => (await a.store.snapshot("owner", "same_conversation")).messages.filter((m) => m.authorType === "user").length).toBe(1);
    await expect.poll(async () => (await b.store.snapshot("owner", "same_conversation")).messages.filter((m) => m.authorType === "user").length).toBe(1);
    const sentA = (await a.store.snapshot("owner", "same_conversation")).messages.find((m) => m.authorType === "user")!;
    expect(sentA.blocks[0]).toEqual({ type: "text", text: "A 留下的草稿" });
    const file = sentA.blocks.find((block) => block.type === "file")!; if (file.type !== "file") throw new Error("file_missing");
    expect(await readFile((await a.attachments.download({ userId: "owner" }, file.attachmentId)).path, "utf8")).toBe("A private attachment");
    expect((await b.store.snapshot("owner", "same_conversation")).messages.find((m) => m.authorType === "user")!.blocks).toEqual([{ type: "text", text: "B 留下的草稿" }]);
    // Switching hosts saves an in-progress recording in its original composer and releases the mic.
    await visible(page).getByRole("button", { name: "录制语音", exact: true }).click();
    await expect(visible(page).getByLabel("录音时长", { exact: true })).not.toHaveText("00:00");
    await choose(page, "Mac mini");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mic: { streams: MediaStream[] } }).__mic.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
    await expect(visible(page).getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    await choose(page, "笔记本"); await expect(visible(page).getByRole("region", { name: "待发送的附件", exact: true }).locator("audio")).toHaveCount(1);
    await visible(page).getByRole("button", { name: /^移除 voice-/ }).click();
    // Both streams update while only B is visible; A's new message stays unread.
    await a.store.publishBotMessage("alpha", { id: "a_unread", conversationId: "same_conversation", blocks: [{ type: "text", text: "A 新回复" }], status: "complete" });
    await expect(visible(page).getByRole("region", { name: "主机：Mac mini", exact: true }).locator(".unread-badge")).toBeVisible();
    await page.evaluate(() => { location.hash = "conversation=same_conversation&message=same_message"; });
    await expect(page.getByRole("alert")).toContainText("无法确定这条通知所属的主机");
    await expect(visible(page).locator(".runtime-host-label").first()).toHaveText("运行于 笔记本");
    await page.getByRole("alert").getByRole("button", { name: "关闭", exact: true }).click();
    await visible(page).getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置", exact: true }).getByText("头像保存在主机「笔记本」上，连接这台主机的其他设备会显示同一头像。", { exact: true })).toBeVisible();
    const hostA = `hub_${createHash("sha256").update(Buffer.from(a.auth.publicKey, "base64")).digest("hex")}`;
    await page.evaluate((host) => { location.hash = `conversation=same_conversation&message=a_unread&host=${host}`; }, hostA);
    await expect(visible(page).locator(".runtime-host-label").first()).toHaveText("运行于 Mac mini");
    await expect(visible(page).locator('[data-message-id="a_unread"]')).toBeVisible();
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
    await page.evaluate(() => { history.replaceState(null, "", location.pathname); });
    await page.screenshot({ path: info.outputPath("hosts-desktop.png"), fullPage: true });
    await clickAppAction(page, "新建群组", visible(page).getByRole("button", { name: "新建群组", exact: true }));
    await expect(page.getByRole("dialog", { name: "选择运行主机", exact: true })).toContainText("Mac mini");
    await page.getByRole("dialog", { name: "选择运行主机", exact: true }).getByRole("button", { name: /笔记本/ }).click();
    await expect(page.getByRole("dialog", { name: "新建群组", exact: true })).toContainText("运行于 笔记本"); await page.keyboard.press("Escape");
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("B 重启后保留");
    await expect(visible(page).getByRole("status", { name: "草稿状态", exact: true })).toHaveText("草稿已保存"); await page.reload();
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("B 重启后保留");
    await page.setViewportSize({ width: 390, height: 844 }); await choose(page, "Mac mini");
    await expect(visible(page).getByRole("heading", { name: "同名对话", exact: true })).toBeVisible();
    await expect(visible(page).locator(".message-blocks").first()).toContainText("A 主机原文");
    // A system picker can outlive its visible host. Identical conversation IDs
    // must never let a late image enter B or silently reappear when revisiting A.
    await visible(page).getByRole("button", { name: "添加附件", exact: true }).click();
    const pendingPicker = page.waitForEvent("filechooser");
    await page.getByRole("dialog", { name: "添加附件", exact: true }).getByRole("button", { name: "附加图片", exact: true }).click();
    const picker = await pendingPicker;
    await choose(page, "笔记本");
    await picker.setFiles({ name: "A-late.png", mimeType: "image/png", buffer: Buffer.from("late synthetic image") });
    await expect(visible(page).getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    await choose(page, "Mac mini");
    await expect(visible(page).getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    // A phone sheet must close on a host-directed notification even when both
    // hosts use the same message/conversation IDs and A stays mounted offscreen.
    await holdMessage(page, visible(page).locator('[data-message-id="same_message"]'));
    await expect(page.getByRole("dialog", { name: "消息操作", exact: true })).toBeVisible();
    const hostB = `hub_${createHash("sha256").update(Buffer.from(b.auth.publicKey, "base64")).digest("hex")}`;
    await page.evaluate(hostId => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail: { hostId, conversationId: "same_conversation", messageId: "same_message" } })), hostB);
    await expect(visible(page).locator(".runtime-host-label").first()).toHaveText("运行于 笔记本");
    await expect(page.getByRole("dialog", { name: "消息操作", exact: true })).toHaveCount(0);
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("B 重启后保留");
    await choose(page, "Mac mini");
    await page.screenshot({ path: info.outputPath("hosts-phone.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await visible(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    await expect(visible(page).locator(".mobile-home").getByRole("heading", { name: "笔记本", exact: true })).toBeVisible();
    await expect(visible(page).locator(".mobile-home")).toBeVisible();
    await page.screenshot({ path: info.outputPath("hosts-phone-navigation.png"), fullPage: true, animations: "disabled" });
    if ((page.viewportSize()?.width ?? 1360) <= 760) await visible(page).locator('.mobile-home').getByRole('button', {name:'我的',exact:true}).click();
    await clickAppAction(page, "设备与网络", visible(page).getByRole("button", { name: "设备与网络", exact: true }).filter({visible:true}));
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "此设备的连接", exact: true });
    await manager.locator(".host-manager-row").first().getByRole("button", { name: "从此设备移除", exact: true }).click();
    await page.getByRole("dialog", { name: "从此设备移除「Mac mini」？", exact: true }).getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(manager.locator(".host-manager-row")).toHaveCount(1); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await expect(visible(page)).toHaveAttribute("data-active-host", hostB);
    await visible(page).locator('.mobile-home .mh-row').filter({hasText:'同名对话'}).click();
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("B 重启后保留");
    expect(errors).toEqual([]);
  } finally { releaseUpload(); await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("duplicate host labels remain distinguishable and offline local removal requires explicit consent while the other host keeps its draft and sends", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-offline-removal-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] }); let aClosed = false;
  try {
    for (const hub of [a, b]) { await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')"); await hub.store.createConversation("owner", ["alpha"], "同名对话", "chat"); }
    await pair(page, a, "电脑 A"); await pair(page, b, "电脑 B", true);
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("B 的离线移除保护草稿");
    if ((page.viewportSize()?.width ?? 1360) <= 760) await visible(page).locator('.mobile-home').getByRole('button', {name:'我的',exact:true}).click();
    await clickAppAction(page, "设备与网络", visible(page).getByRole("button", { name: "设备与网络", exact: true }).filter({visible:true}));
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "此设备的连接", exact: true });
    const currentWorkspace = await page.locator(".host-workspace:not([hidden])").getAttribute("data-active-host");
    await manager.locator(".host-manager-row").first().getByRole("button", { name: "设置连接", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "连接状态与线路", exact: true })).toContainText("电脑 A");
    expect(await page.locator(".host-workspace:not([hidden])").getAttribute("data-active-host")).toBe(currentWorkspace);
    await page.getByRole("button", { name: "返回此设备的连接", exact: true }).click();
    await expect(manager.locator(".host-manager-row").first().getByRole("button", { name: "设置连接", exact: true })).toBeFocused();
    await manager.locator(".host-manager-row").last().getByRole("button", { name: "修改名称", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "修改主机名称", exact: true });
    await rename.getByRole("textbox", { name: "主机名称", exact: true }).fill("未保存的名称");
    await rename.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("dialog", { name: "放弃主机名称修改？", exact: true }).getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(rename.getByRole("textbox", { name: "主机名称", exact: true })).toHaveValue("未保存的名称");
    await rename.getByRole("textbox", { name: "主机名称", exact: true }).fill("电脑 A");
    await rename.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(manager.getByRole('status')).toContainText('主机名称已保存为「电脑 A」');
    await expect(manager.getByRole('button', { name: '关闭连接管理', exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(manager).toBeHidden();
    await page.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    const hostOptions = visible(page).getByRole("combobox", { name: "筛选运行主机", exact: true }).locator("option");
    await expect(hostOptions).toHaveText(["全部主机", /电脑 A · [0-9a-f]{8}/, /电脑 A · [0-9a-f]{8}/]);
    const options = await hostOptions.allTextContents();
    expect(options.slice(1)).toHaveLength(2); expect(options[1]).not.toBe(options[2]); expect(options[1]).toMatch(/电脑 A · [0-9a-f]{8}/); expect(options[2]).toMatch(/电脑 A · [0-9a-f]{8}/);
    await a.close(); aClosed = true;
    await expect(visible(page).getByRole("region", { name: `主机：${options[1]}`, exact: true }).locator(".host-heading")).toHaveAttribute("aria-label", `${options[1]}，离线`);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: info.outputPath("hosts-dark-offline.png"), fullPage: true });
    if ((page.viewportSize()?.width ?? 1360) <= 760) await visible(page).locator('.mobile-home').getByRole('button', {name:'我的',exact:true}).click();
    await clickAppAction(page, "设备与网络", visible(page).getByRole("button", { name: "设备与网络", exact: true }).filter({visible:true}));
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
    await manager.locator(".host-manager-row").first().getByRole("button", { name: "从此设备移除", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "从此设备移除「电脑 A」？", exact: true });
    await expect(confirmation.getByRole("button", { name: "确认移除", exact: true })).toBeDisabled();
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(manager.locator(".host-manager-row")).toHaveCount(2);
    await expect(manager.locator(".host-manager-row").first().getByRole("button", { name: "从此设备移除", exact: true })).toBeFocused();
    await manager.locator(".host-manager-row").first().getByRole("button", { name: "从此设备移除", exact: true }).click();
    await expect(confirmation).toContainText("无法确认远端注销"); await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(manager.locator(".host-manager-row")).toHaveCount(1); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("B 的离线移除保护草稿");
    await visible(page).getByRole("button", { name: "发送消息", exact: true }).click();
    const conversation = (await b.store.conversations("owner"))[0]!;
    await expect.poll(async () => (await b.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "user").length).toBe(1);
  } finally { await page.close(); if (!aClosed) await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failed draft write never reports saved and protects reload until a successful edit", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-draft-save-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "同名对话", "draft");
    await hub.store.createConversation("owner", ["alpha"], "另一对话", "other");
    await pair(page, hub, "草稿主机");
    await visible(page).locator(".conversation-row").filter({ hasText: "同名对话" }).click();
    await expect(visible(page).getByRole("heading", { name: "同名对话", exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === "settings" && typeof key === "string" && key.startsWith("draft:")) { IDBObjectStore.prototype.put = original; throw new DOMException("fixture_draft_storage_full", "QuotaExceededError"); }
        return original.call(this, value, key);
      };
    });
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("不能谎称已保存");
    await expect(visible(page).getByRole("status", { name: "草稿状态", exact: true })).toHaveText("草稿未保存");
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
    await visible(page).locator(".conversation-row").filter({ hasText: "另一对话" }).click();
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    await visible(page).locator(".conversation-row").filter({ hasText: "同名对话" }).click();
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("不能谎称已保存");
    await expect(visible(page).getByRole("status", { name: "草稿状态", exact: true })).toHaveText("草稿未保存");
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("重新编辑后保存");
    await expect(visible(page).getByRole("status", { name: "草稿状态", exact: true })).toHaveText("草稿已保存");
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
    await page.reload();
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("重新编辑后保存");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
