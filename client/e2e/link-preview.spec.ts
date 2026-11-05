import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, selectConversation, enterMobileChat } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const draft = (page: Page) => page.getByRole("region", { name: "待发送的链接预览", exact: true });
const composer = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });
const send = (page: Page) => page.getByRole("button", { name: "发送消息", exact: true }).click();

test("device link style defaults to cards, persists in settings and survives sync and forwarding", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "link-style-")), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const article = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
  const select = selectConversation;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手','fixture')");
    const source = await hub.store.createConversation("owner", ["alpha"], "产品设计讨论", "source"), target = await hub.store.createConversation("owner", ["alpha"], "参考资料", "target");
    hub.linkPreviews.read = async (url) => ({ url, status: "ready", title: "链接预览设计：让电脑和手机上的讨论更清楚，长标题也不挤占消息空间", siteName: "TaroCub", description: "在设置里选择标题或卡片；阅读时随时展开详情，消息和显示方式在两端保持一致。", image: { mime: "image/png", body: png } });
    await pair(desktop, hub); await pair(phone, hub); await select(desktop, source.title); await select(phone, source.title);
    await composer(desktop).fill("先看标题，详细说明可以展开 https://example.org/design");
    await expect(draft(desktop)).toContainText("链接预览设计");
    await expect(draft(desktop).getByRole("group", { name: "链接显示方式", exact: true })).toHaveCount(0);
    await expect(draft(desktop).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "card");
    await expect(draft(desktop).locator(".link-preview-description")).toBeVisible();
    await openSettings(desktop);
    await expect(desktop.getByLabel("链接预览样式", { exact: true })).toHaveValue("card");
    await expect(desktop.getByText("卡片显示标题、摘要和封面（网页提供时）；标题仅显示标题和域名。", { exact: true })).toBeVisible();
    await desktop.getByLabel("链接预览样式", { exact: true }).selectOption("inline");
    await desktop.screenshot({ path: info.outputPath("link-style-settings.png"), fullPage: true });
    await closeSettings(desktop);
    await expect(composer(desktop)).toHaveValue("先看标题，详细说明可以展开 https://example.org/design");
    await expect(draft(desktop).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    await expect(draft(desktop).locator(".link-preview-cover")).toHaveCount(0);
    await expect(draft(desktop).locator(".link-preview-description")).toHaveCount(0);
    await expect(draft(desktop).locator(".link-preview-card")).toHaveCSS("box-shadow", "none");
    await send(desktop);
    await expect(phone.locator(".message-blocks .link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    const first = (await hub.store.snapshot("owner", source.id)).messages[0]!; expect(first.previewStyle).toBe("inline");
    const phoneFirst = article(phone, first.id);
    await phoneFirst.getByRole("button", { name: "展开链接详情", exact: true }).click();
    await expect(phoneFirst.locator(".link-preview-description")).toContainText("在设置里选择标题或卡片");
    await expect(phoneFirst.locator(".link-preview-card")).toHaveAttribute("data-preview-style", "card");
    await expect(article(desktop, first.id).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    await phoneFirst.getByRole("button", { name: "收起链接详情", exact: true }).click();
    await composer(phone).fill("这条直接看详情 https://example.org/design");
    await expect(draft(phone).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "card");
    await expect(draft(phone).getByRole("button", { name: "卡片", exact: true })).toHaveCount(0);
    await send(phone); await expect(desktop.locator(".message-blocks .link-preview-card")).toHaveCount(2);
    const second = (await hub.store.snapshot("owner", source.id)).messages[1]!; expect(second.previewStyle).toBe("card");
    for (const [page, name] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await expect(article(page, second.id).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "card");
      await expect(article(page, second.id).locator(".link-preview-description")).toContainText("在设置里选择标题或卡片");
      await expect.poll(() => article(page, second.id).locator(".link-preview-cover").evaluateAll((images) => images.length === 1 && (images[0] as HTMLImageElement).naturalWidth > 0)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`link-styles-${name}.png`), fullPage: true });
    }
    // Flat title links inherit the user's bubble colours, including reversed
    // CLI and reversed monochrome themes, rather than the page's foreground.
    for (const palette of ["cli", "mono"]) for (const theme of ["light", "dark"]) {
      await phone.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      const titleLink = phoneFirst.locator(".link-preview-card");
      const expectedColor = await titleLink.evaluate(node => {
        const probe = document.createElement("span"); probe.style.color = "var(--self-message-fg)";
        node.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color;
      });
      await expect(titleLink).toHaveCSS("color", expectedColor);
      await expect(titleLink).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await phone.screenshot({ path: info.outputPath(`link-styles-${palette}-${theme}.png`), fullPage: true, animations: "disabled" });
    }
    // Expanding a sent title must not change its durable style or the forwarded copy.
    await article(desktop, first.id).getByRole("button", { name: "展开链接详情", exact: true }).click();
    await article(desktop, first.id).getByRole("button", { name: "转发消息", exact: true }).click();
    const dialog = desktop.getByRole("dialog", { name: "转发消息", exact: true });
    await dialog.getByRole("button", { name: target.title, exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: "让 Bot 回复这条转发", exact: true })).toBeChecked();
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await select(phone, target.title); await expect(phone.locator(".message-blocks .link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    expect((await hub.store.snapshot("owner", target.id)).messages[0]!.previewStyle).toBe("inline");
    await desktop.reload(); await select(desktop, source.title);
    await expect(article(desktop, first.id).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    await expect(article(desktop, second.id).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "card");
    const pending = await hub.store.pendingForBot("alpha");
    expect(pending.filter(message => message.conversationId === source.id)).toHaveLength(2);
    expect(pending.filter(message => message.conversationId === target.id)).toEqual([expect.objectContaining({ mentions: ["alpha"], previewStyle: "inline" })]);
    expect((await hub.store.snapshot("owner", source.id)).messages).toHaveLength(2);
    // Sending must not reset the device setting, and reloading must retain it.
    await composer(desktop).fill("下一条 https://example.org/design");
    await expect(draft(desktop).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    await openSettings(phone);
    await expect(phone.getByLabel("链接预览样式", { exact: true })).toHaveValue("card");
    await phone.getByLabel("链接预览样式", { exact: true }).selectOption("inline");
    await closeSettings(phone); await select(phone, target.title);
    await composer(phone).fill("手机草稿 https://example.org/design");
    await phone.reload(); await select(phone, target.title);
    await expect(composer(phone)).toHaveValue("手机草稿 https://example.org/design");
    await expect(draft(phone).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "inline");
    // A later settings change applies to the pending draft, not sent history.
    await openSettings(phone);
    await phone.getByLabel("链接预览样式", { exact: true }).selectOption("card");
    await closeSettings(phone); await select(phone, target.title);
    await expect(draft(phone).locator(".link-preview-card")).toHaveAttribute("data-preview-style", "card");
    await expect(phone.locator(".message-blocks .link-preview-card")).toHaveAttribute("data-preview-style", "inline");
  } finally { await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop and phone share a selected link card inside the caption bubble, and can disable the next preview", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "link-ui-")), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(); const reads: string[] = [];
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "产品设计讨论", "links");
    hub.linkPreviews.read = async (url) => { reads.push(url); return { url, status: "ready", title: url.endsWith("/design") ? "让链接在对话里更清楚" : "TaroCub · 项目介绍", siteName: "TaroCub", description: "消息里的标题、摘要和封面，让电脑与手机上的讨论保持一致。", image: { mime: "image/png", body: png } }; };
    await pair(desktop, hub); await pair(phone, hub); await enterMobileChat(phone, conversation.title);
    await composer(desktop).fill("看看这个方案 https://example.org/project ，补充参考 https://example.org/design");
    await expect(draft(desktop)).toContainText("TaroCub · 项目介绍");
    await desktop.getByRole("combobox", { name: "选择预览链接", exact: true }).selectOption("https://example.org/design");
    await expect(draft(desktop)).toContainText("让链接在对话里更清楚");
    expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    await desktop.screenshot({ path: info.outputPath("link-draft-desktop.png"), fullPage: true });
    await send(desktop);
    await expect(phone.locator(".message-blocks .link-preview-card")).toContainText("让链接在对话里更清楚");
    const message = (await hub.store.snapshot("owner", conversation.id)).messages[0]!;
    expect(message.previewUrl).toBe("https://example.org/design"); expect(message.blocks.map((b) => b.type)).toEqual(["text"]);
    expect(reads).toEqual(["https://example.org/project", "https://example.org/design"]);
    const cover = await hub.attachments.download({ userId: "owner" }, message.linkPreview!.imageAttachmentId!); expect(await readFile(cover.path)).toEqual(png);
    await composer(phone).fill("这张图可以一起参考 https://example.org/design");
    await phone.locator('input[type="file"][multiple]').setInputFiles({ name: "界面方案.png", mimeType: "image/png", buffer: png });
    await expect(draft(phone)).toContainText("让链接在对话里更清楚");
    await phone.screenshot({ path: info.outputPath("link-draft-phone.png"), fullPage: true });
    await send(phone); await expect(desktop.locator(".message-blocks .link-preview-card")).toHaveCount(2);
    expect((await hub.store.snapshot("owner", conversation.id)).messages[1]!.blocks.map((b) => b.type)).toEqual(["text", "image"]);
    await expect(phone.locator(".link-preview-cover")).toHaveCount(2);
    await expect.poll(() => phone.locator(".link-preview-cover").evaluateAll((images) => images.every((img) => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    // Cached cover bytes must survive WebKit reload even with attachment HTTP blocked.
    await phone.route("**/api/attachments/**", (route) => route.abort());
    await phone.reload(); await enterMobileChat(phone, conversation.title); await expect(phone.locator(".message-blocks .link-preview-card")).toHaveCount(2);
    for (const [page, name] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await expect(page.locator(".link-preview-cover"), name).toHaveCount(2);
      await expect.poll(() => page.locator(".link-preview-cover").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`link-bubbles-${name}.png`), fullPage: true });
    }
    await phone.unroute("**/api/attachments/**");
    await phone.evaluate(async (databaseName) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); });
      const tx = db.transaction(["attachmentData", "attachmentMeta"], "readwrite"); tx.objectStore("attachmentData").clear(); tx.objectStore("attachmentMeta").clear();
      await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); }); db.close();
    }, await singleHostCacheName(phone));
    // With an empty cache, history renders before authentication; covers and user
    // images must retry themselves once the socket is online.
    await phone.reload(); await enterMobileChat(phone, conversation.title); await expect(phone.locator(".link-preview-cover")).toHaveCount(2);
    await expect.poll(() => phone.locator(".link-preview-cover").evaluateAll((images) => images.every((img) => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await expect.poll(() => phone.locator(".attachment-image img").evaluateAll((images) => images.length === 1 && (images[0] as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await composer(phone).fill("https://example.org/no-preview"); await phone.getByRole("button", { name: "关闭链接预览", exact: true }).click();
    await expect(draft(phone)).toHaveCount(0); await phone.getByRole("button", { name: "显示链接预览", exact: true }).click();
    await phone.getByRole("button", { name: "关闭链接预览", exact: true }).click(); await send(phone);
    await expect(desktop.locator(".message-blocks").getByRole("link", { name: "https://example.org/no-preview", exact: true })).toBeVisible();
    const disabled = (await hub.store.snapshot("owner", conversation.id)).messages[2]!; expect(disabled.previewUrl).toBeNull(); expect(disabled.linkPreview).toBeUndefined();
    expect(reads).not.toContain("https://example.org/no-preview"); expect(await hub.store.pendingForBot("alpha")).toHaveLength(3);
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))).toHaveLength(2);
  } finally { await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("slow and inaccessible pages never block sending or replace a different draft's preview", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "link-slow-")), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let finish: (() => void) | undefined, started = false;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "链接发送", "slow");
    hub.linkPreviews.read = async (url) => {
      if (url.endsWith("/slow")) { started = true; await new Promise<void>((resolve) => { finish = resolve; }); }
      if (url.endsWith("/private")) throw new Error("login_required");
      return { url, status: "ready", title: url.endsWith("/slow") ? "慢网页" : "新网页", siteName: "Example" };
    };
    await pair(page, hub); await composer(page).fill("https://example.org/slow"); await expect.poll(() => started).toBe(true);
    await send(page); await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.length).toBe(1);
    expect((await hub.store.snapshot("owner", conversation.id)).messages[0]!.linkPreview).toBeUndefined();
    await composer(page).fill("后发的消息"); await send(page);
    await composer(page).fill("https://example.org/new"); await expect(draft(page)).toContainText("新网页"); finish!();
    await expect(page.locator(".message-blocks .link-preview-card")).toContainText("慢网页"); await expect(draft(page)).toContainText("新网页"); await expect(draft(page)).not.toContainText("慢网页");
    // Draft previews now intentionally take precedence in the conversation list.
    // Clear the checked draft before asserting the durable last-message preview.
    await composer(page).fill("");
    await expect(page.locator(".conversation-row")).toContainText("后发的消息");
    // Force the snapshot route: metadata enrichment must not move an older
    // message to the conversation preview on reconnect either.
    await page.evaluate(async ({id,databaseName}) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); });
      const tx = db.transaction("cursors", "readwrite"); tx.objectStore("cursors").put(9999, id);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    }, {id:conversation.id,databaseName:await singleHostCacheName(page)});
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator(".conversation-row")).toContainText("后发的消息");
    await expect(page.locator(".message-blocks .link-preview-card")).toContainText("慢网页");
    await composer(page).fill("https://example.org/private");
    await expect(draft(page)).toContainText("打开原链接");
    await expect(draft(page).locator(".link-preview-description")).toBeVisible();
    await send(page);
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages[2]?.linkPreview?.status).toBe("unavailable");
    await expect(page.locator(".message-blocks").getByRole("link", { name: "https://example.org/private", exact: true })).toBeVisible();
    await expect(page.locator(".message-blocks .link-preview-card").last()).toContainText("打开原链接");
    expect(await hub.store.pendingForBot("alpha")).toHaveLength(3);
  } finally { finish?.(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
