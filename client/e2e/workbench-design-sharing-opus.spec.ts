import { test, expect, type Page, type Frame } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

// Opus CC1: real App collaboration between two paired devices of the same
// owner (separate browser contexts = separate device identities and IndexedDB),
// a real temporary Hub with signed sockets, the built client and the real
// upstream editor. Not physical devices, not Electron, not two Hub users.
const clientDir = process.env.OPUS_CLIENT_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
test.skip(!process.env.OPUS_CLIENT_DIST, "set OPUS_CLIENT_DIST to a built client directory");
test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
async function connect(page: Page, hub: HubServer, title: string, userId = "owner") {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner", userId); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, title);
  await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible();
}
async function newDesign(page: Page) {
  await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
  await panel(page).getByRole("menu").getByRole("button", { name: "画布", exact: true }).click();
  // The product hides this entry. Reveal it only in this legacy collaboration
  // fixture so the retained sharing component/protocol still has coverage.
  await panel(page).locator(".workbench-design-sharing-entry").evaluate(node => node.removeAttribute("hidden"));
}
// Any nested editor frame (the artboard depth depends on the editor build).
const artboards = (page: Page) => page.frames().filter(frame => frame !== page.mainFrame() && frame.parentFrame() !== page.mainFrame());
const depth = (frame: Frame) => { let n = 0; for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) n++; return n; };
const frameTree = (page: Page) => page.frames().map(frame => `${depth(frame)}:${frame.url().slice(0, 40)}`);
const headings = (page: Page) => Promise.all(artboards(page).map(frame => frame.locator("h1").first().textContent({ timeout: 300 }).catch(() => "")));
async function artboardWith(page: Page, text: string): Promise<Frame> {
  try { await expect.poll(() => headings(page), { timeout: 30000 }).toContain(text); }
  catch (error) { console.log("OPUS_FRAMES", JSON.stringify(frameTree(page)), JSON.stringify(await headings(page)), JSON.stringify((await panel(page).innerText().catch(() => "")).slice(0, 600))); throw error; }
  for (const frame of artboards(page)) if ((await frame.locator("h1").first().textContent({ timeout: 300 }).catch(() => "")) === text) return frame;
  throw new Error(`no artboard shows ${text}`);
}
async function editHeading(page: Page, frame: Frame, text: string) {
  await frame.locator("h1").first().dblclick(); await page.keyboard.press("Meta+A"); await page.keyboard.type(text); await page.keyboard.press("Escape");
}

test("opus: owner shares a Baoyu design from one device and edits it from another; disconnect retires the copy until an explicit rejoin", async ({ page, browser }) => {
  test.setTimeout(180000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-share-e2e-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "共享验收", "design_share");
  const otherContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" }), other = await otherContext.newPage();
  const errors: string[] = []; for (const device of [page, other]) device.on("pageerror", error => { errors.push(error.message); console.log("OPUS_PAGEERROR", error.message.slice(0, 300)); });
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  try {
    // Device A: create a design, give it a recognisable title, share it (explicit click).
    await connect(page, hub, conversation.title); await newDesign(page);
    await editHeading(page, await artboardWith(page, "画布"), "Shared from A");
    await artboardWith(page, "Shared from A");
    await panel(page).getByRole("button", { name: /^共享/ }).click();
    const dialog = page.getByRole("dialog", { name: "共享与协作", exact: true });
    await dialog.getByRole("button", { name: "开始共享", exact: true }).click();
    await expect(dialog.getByText("正在从这台设备共享。", { exact: true })).toBeVisible({ timeout: 15000 });
    // The grant picker lists the conversation's real Hub members (only the owner here).
    await expect(dialog.getByText("这个对话里没有其他成员。", { exact: true })).toBeVisible({ timeout: 15000 });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();

    // Device B (the owner's other device): find it under "Shared with me" and open it.
    await connect(other, hub, conversation.title); await newDesign(other); await artboardWith(other, "画布");
    await panel(other).getByRole("button", { name: /^共享/ }).click();
    const otherDialog = other.getByRole("dialog", { name: "共享与协作", exact: true });
    const item = otherDialog.locator(".design-sharing-list li").filter({ hasText: "画布" });
    await expect(item).toContainText("所有者", { timeout: 15000 }); await expect(item).toContainText("源设备在线");
    await item.getByRole("button", { name: "打开", exact: true }).click();
    const viewer = other.getByRole("region", { name: /^共享的设计：/ });
    await expect(viewer).toBeVisible();
    // Shared copies say plainly that Send to Bot happens on the sharing device.
    await expect(viewer.getByText(/不能从这里发给 Bot/)).toBeVisible();
    // The joined copy renders A's content through the Host, then B edits it.
    await editHeading(other, await artboardWith(other, "Shared from A"), "Edited on B");
    // The edit is committed on device A, which holds the document.
    const sourceContains = async (text: string) => {
      const targets = await workbenchContentTargets(broker, actor), found: string[] = [];
      for (const target of targets) for (const tab of target.tabs.filter(tab => tab.kind === "design")) {
        const read = await broker.request(actor, { requestId: `read-${target.windowId}-${tab.id}-${Date.now()}`, operation: "design.read", target: { deviceId: target.deviceId, windowId: target.windowId, tabId: tab.id }, payload: { path: "project/Main.dc.html" } }).catch(() => undefined);
        const content = (read?.result as { content?: string } | undefined)?.content ?? "";
        if (content.includes(text)) found.push(target.deviceId);
      }
      return found.length;
    };
    await expect.poll(() => sourceContains("Edited on B"), { timeout: 30000 }).toBe(1);
    console.log("OPUS_SHARE_A_FRAME", JSON.stringify(await headings(page)));

    // B loses its connection: the copy retires at once; recovery is an explicit rejoin.
    await otherContext.setOffline(true);
    await expect(viewer.getByText("连接已断开。重新加入后继续；断开期间不会在本机保存修改。", { exact: true })).toBeVisible({ timeout: 30000 });
    await otherContext.setOffline(false); await waitForClientOnline(other);
    await viewer.getByRole("button", { name: "重新加入", exact: true }).click();
    await expect(viewer.getByText("连接已断开。重新加入后继续；断开期间不会在本机保存修改。", { exact: true })).toHaveCount(0, { timeout: 15000 });
    await artboardWith(other, "Edited on B");

    // Leave right after typing: the last edit is saved on A before the copy is revoked.
    await editHeading(other, await artboardWith(other, "Edited on B"), "Left from B");
    await viewer.getByRole("button", { name: "离开", exact: true }).click();
    await expect(viewer).toHaveCount(0, { timeout: 15000 });
    await expect.poll(() => sourceContains("Left from B"), { timeout: 30000 }).toBe(1);
    // Reopen from "Shared with me" for the stop-sharing check below.
    await panel(other).getByRole("button", { name: /^共享/ }).click();
    await otherDialog.locator(".design-sharing-list li").filter({ hasText: "画布" }).getByRole("button", { name: "打开", exact: true }).click();
    await expect(viewer).toBeVisible(); await artboardWith(other, "Left from B");

    // A stops sharing: B's copy ends, and A's document keeps the shared edit.
    await panel(page).getByRole("button", { name: /^共享/ }).click();
    await dialog.getByRole("button", { name: "停止共享", exact: true }).click();
    await dialog.getByRole("alertdialog", { name: "停止共享", exact: true }).getByRole("button", { name: "停止共享", exact: true }).click();
    await expect(viewer.getByText("你的访问已被撤销或共享已结束。", { exact: true })).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  } finally {
    await otherContext.close(); await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("opus: the owner grants a real conversation member view-only access from the member picker, then revokes it", async ({ page, browser }) => {
  test.setTimeout(180000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-share-member-e2e-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  await hub.store.db.run("INSERT INTO users VALUES('guest','访客','member')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "成员共享", "design_member_share");
  await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversation.id]);
  const guestContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" }), guest = await guestContext.newPage();
  const errors: string[] = []; for (const device of [page, guest]) device.on("pageerror", error => { errors.push(error.message); console.log("OPUS_PAGEERROR", error.message.slice(0, 300)); });
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  try {
    await connect(page, hub, conversation.title); await newDesign(page);
    await editHeading(page, await artboardWith(page, "画布"), "Owner only text"); await artboardWith(page, "Owner only text");
    await panel(page).getByRole("button", { name: /^共享/ }).click();
    const dialog = page.getByRole("dialog", { name: "共享与协作", exact: true });
    await dialog.getByRole("button", { name: "开始共享", exact: true }).click();
    const picker = dialog.getByRole("combobox", { name: "访客 的权限", exact: true });
    await expect(picker).toHaveValue("none", { timeout: 15000 });
    await picker.selectOption("viewer");
    await expect(picker).toHaveValue("viewer");

    await connect(guest, hub, conversation.title, "guest"); await newDesign(guest); await artboardWith(guest, "画布");
    await panel(guest).getByRole("button", { name: /^共享/ }).click();
    const item = guest.getByRole("dialog", { name: "共享与协作", exact: true }).locator(".design-sharing-list li").filter({ hasText: "画布" });
    await expect(item).toContainText("仅查看", { timeout: 15000 });
    await item.getByRole("button", { name: "打开", exact: true }).click();
    const viewer = guest.getByRole("region", { name: /^共享的设计：/ });
    await expect(viewer).toContainText("仅查看");
    const copy = await artboardWith(guest, "Owner only text");
    // A view-only copy cannot change the owner's document.
    await editHeading(guest, copy, "Guest tried to edit");
    await guest.waitForTimeout(3000);
    const targets = await workbenchContentTargets(broker, actor), contents: string[] = [];
    for (const target of targets) for (const tab of target.tabs.filter(tab => tab.kind === "design")) {
      const read = await broker.request(actor, { requestId: `member-read-${tab.id}`, operation: "design.read", target: { deviceId: target.deviceId, windowId: target.windowId, tabId: tab.id }, payload: { path: "project/Main.dc.html" } });
      contents.push((read.result as { content?: string }).content ?? "");
    }
    expect(contents.some(content => content.includes("Owner only text"))).toBe(true);
    expect(contents.some(content => content.includes("Guest tried to edit"))).toBe(false);
    // Revoking from the picker ends the guest's session at once.
    await picker.selectOption("none");
    await expect(viewer.getByText("你的访问已被撤销或共享已结束。", { exact: true })).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  } finally {
    await guestContext.close(); await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("owner deletes a shared design offline, then ends its orphan share from the empty Workbench", async ({ page }) => {
  test.setTimeout(180000); page.setDefaultTimeout(15000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-orphan-e2e-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Design Bot','fixture')");
  const conversation = await hub.store.createConversation("owner", ["bot"], "Orphan share recovery", "new");
  const records = async () => (await hub.store.db.serial(() => hub.store.db.all<{ value: string }>("SELECT value FROM meta WHERE key LIKE 'workbench-design-share:%'"))).map(row => JSON.parse(row.value));
  try {
    await connect(page, hub, conversation.title); await newDesign(page); await artboardWith(page, "画布");
    await panel(page).getByRole("button", { name: /^共享/ }).click();
    const dialog = page.getByRole("dialog", { name: "共享与协作", exact: true });
    await dialog.getByRole("button", { name: "开始共享", exact: true }).click();
    await expect(dialog.getByText("正在从这台设备共享。", { exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await expect(dialog.getByText("当前未连接主机，无法共享或加入。", { exact: true })).toBeVisible({ timeout: 15000 });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await panel(page).getByRole("tab", { name: "画布", exact: true }).click({ button: "right" });
    await page.getByRole("button", { name: "关闭标签", exact: true }).click();
    await expect(panel(page).getByRole("tab")).toHaveCount(0);
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "删除这个设计：画布", exact: true }).click();
    await page.getByRole("button", { name: "删除设计", exact: true }).click();
    await expect.poll(async () => (await records()).map(record => record.state)).toEqual(["open"]);
    await page.context().setOffline(false); await waitForClientOnline(page);
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "共享给我的项目", exact: true }).click();
    const shared = page.getByRole("region", { name: "共享给我的项目", exact: true });
    const row = shared.locator(".design-sharing-list li").filter({ hasText: "画布" });
    await expect(row).toContainText("源设备离线", { timeout: 15000 });
    await expect(row.getByRole("button", { name: "打开", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "结束共享：画布", exact: true }).click();
    await test.info().attach("orphan-end-share-confirmation", { body: await page.screenshot(), contentType: "image/png" });
    await row.getByRole("button", { name: "取消", exact: true }).click();
    expect((await records())[0].state).toBe("open");
    await row.getByRole("button", { name: "结束共享：画布", exact: true }).click();
    await row.getByRole("alertdialog").getByRole("button", { name: "结束共享", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await records()).map(record => record.state)).toEqual(["closed"]);
    await expect(panel(page).getByRole("tab")).toHaveCount(0);
  } finally { await page.context().setOffline(false); await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
