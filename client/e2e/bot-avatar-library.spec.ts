import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "../../src/hub/bot-avatar-default.js";
import { BOT_AVATAR_LIBRARY, defaultBotAvatar } from "../src/bot-avatar-catalog.js";
import { openBotSettings, closeBotSettings } from "./fixtures/bot-settings.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { avatarFixture } from "../../tests/helpers/avatar-fixture.js";

test.use({ actionTimeout: 15_000 });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
const avatar = (page: Page) => page.locator('[data-avatar="bot:alpha"]').first();
const editor = (page: Page) => page.getByRole("dialog", { name: "编辑Bot 头像", exact: true });
const save = async (page: Page) => { await editor(page).getByRole("button", { name: "保存头像", exact: true }).click(); await expect(editor(page)).toHaveCount(0); };
const edit = (page: Page) => page.getByRole("button", { name: "设置Bot 头像", exact: true }).click();

// Decode real packaged pixels and synced PNGs; a transparent CSS box alone
// cannot prove that a sprite has lost its original colored square background.
async function cutoutPixels(page: Page, selector: string) {
  return page.locator(selector).evaluateAll(async (nodes) => Promise.all(nodes.map(async (node) => {
    // Phone layouts intentionally keep some desktop avatars hidden/lazy. Decode
    // their actual source separately without forcing those copies on screen.
    const original = node as HTMLImageElement, image = new Image();
    image.src = original.currentSrc || original.src; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0, 256, 256);
    const pixels = ctx.getImageData(0, 0, 256, 256).data;
    let empty = 0, solid = 0, border = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const a = pixels[(y * 256 + x) * 4 + 3]!;
      if (a < 3) empty++; if (a > 240) solid++;
      if (x < 8 || x >= 248 || y < 8 || y >= 248) border = Math.max(border, a);
    }
    return { empty: empty / 65536, solid: solid / 65536, border };
  })));
}
async function expectCutouts(page: Page, selector: string) {
  for (const pixels of await cutoutPixels(page, selector)) {
    expect(pixels.border).toBe(0);
    expect(pixels.empty).toBeGreaterThan(.2);
    expect(pixels.solid).toBeGreaterThan(.2);
  }
}

test("an unavailable avatar editor leaves the chat and draft usable", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatar-editor-recovery-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','精灵助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "头像故障恢复", "avatar-recovery");
    await pair(page, hub);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留这份未发送草稿");
    await page.route("**/AvatarEditorDialog-*.js", route => route.abort());
    await openBotSettings(page);
    await edit(page);
    await expect(page.getByRole("alert")).toContainText("头像编辑暂不可用");
    await expect(page.getByRole("button", { name: "设置Bot 头像", exact: true })).toBeEnabled();
    await closeBotSettings(page);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留这份未发送草稿");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("仍可继续编辑");
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("sidebar activity reordering keeps the nested avatar picker modal and settings reopenable", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatar-sidebar-modal-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const other = await HubServer.start({ stateDir: path.join(root, "other"), origins: [hub.url] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','精灵助手','fixture'),('beta','后台助手','fixture')");
    const a = await hub.store.createConversation("owner", ["alpha"], "头像所在对话", "avatar-owner");
    const b = await hub.store.createConversation("owner", ["beta"], "后台持续回复", "avatar-background");
    // Creation and the first message can share one millisecond. In that case
    // name ordering correctly puts beta first, unrelated to modal stability.
    // Give the fixture an unambiguous initial activity order before pairing.
    await hub.store.db.run("UPDATE conversations SET created_at=? WHERE id IN (?,?)", [Date.now() - 1000, a.id, b.id]);
    await hub.store.publishBotMessage("alpha", { conversationId: a.id, status: "complete", blocks: [{ type: "text", text: "开始选择头像" }] });
    await pair(page, hub);
    await clickAppAction(page, "连接另一台主机");
    await page.getByLabel("主机名称", { exact: true }).fill("另一台验收主机");
    await page.getByLabel("Hub 地址", { exact: true }).fill(other.url);
    await preparePairing(page, other); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await other.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await page.locator(".host-workspace:not([hidden]) .conversation-row").filter({ has: page.getByText(a.title, { exact: true }) }).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("头像设置前的草稿");
    const bot = page.locator('.host-workspace:not([hidden]) .combined-sidebar .bot-identity').filter({ hasText: "精灵助手" });
    const firstBot = page.locator('.host-workspace:not([hidden]) .combined-sidebar .bot-tree').first();
    await expect(firstBot).toHaveAttribute("data-bot-id", "alpha");
    const openFromSidebar = async () => {
      await bot.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
    };
    await openFromSidebar(); await edit(page);
    await editor(page).getByRole("button", { name: "选择星星猫头像", exact: true }).click();
    await hub.store.publishBotMessage("beta", { conversationId: b.id, status: "complete", blocks: [{ type: "text", text: "另一段对话更新，Bot 列表真实重排" }] });
    await expect(firstBot).toHaveAttribute("data-bot-id", "beta");
    await info.attach("modal-state-after-row-move", { contentType: "application/json", body: JSON.stringify(await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(node => ({ title: node.getAttribute('aria-label'), modal: node.matches(':modal'), inSidebar: !!node.closest('.combined-sidebar') })))) });
    await page.screenshot({ path: info.outputPath("avatar-after-sidebar-update.png"), animations: "disabled" });
    await expect.poll(() => editor(page).evaluate(node => node.matches(":modal"))).toBe(true);
    await expect(editor(page).getByRole("button", { name: "选择星星猫头像", exact: true })).toHaveAttribute("aria-pressed", "true");
    // Measure stability after the existing opening animation has finished.
    await editor(page).evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const bounds = await editor(page).boundingBox();
    for (const chat of [a, b, a, b]) {
      const botId = chat === a ? "alpha" : "beta";
      await hub.store.publishBotMessage(botId, { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: "连续更新时保持头像选择和弹窗位置" }] });
      await expect(firstBot).toHaveAttribute("data-bot-id", botId);
      await expect.poll(() => editor(page).evaluate(node => node.matches(":modal"))).toBe(true);
      expect(await editor(page).boundingBox()).toEqual(bounds);
      await expect(editor(page).getByRole("button", { name: "选择星星猫头像", exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: info.outputPath("avatar-sidebar-dark.png"), animations: "disabled" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    // Native Back closes only the child, retaining the settings dialog and focus.
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "设置Bot 头像", exact: true })).toBeFocused();
    await expect.poll(() => page.getByRole("dialog", { name: "Bot 设置", exact: true }).evaluate(node => node.matches(":modal"))).toBe(true);
    await page.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click();
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await expect(composer).toHaveValue("头像设置前的草稿");
    await expect(bot).toBeFocused();
    await openFromSidebar(); await edit(page);
    await editor(page).getByRole("button", { name: "选择橘猫头像", exact: true }).click(); await save(page);
    await expect(page.getByRole("button", { name: "设置Bot 头像", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click();
    await expect(composer).toBeEditable();
    expect((await hub.avatars.list("owner")).find(value => value.id === "alpha")).toMatchObject({ revision: 1, hasImage: true });
    expect(await other.avatars.list("owner")).toEqual([]);
    // Conversation slices move too; an unsaved rename stays modal and editable.
    const sidebar = page.locator(".host-workspace:not([hidden]) .sidebar");
    await sidebar.getByRole("button", { name: "按对话", exact: true }).click();
    await hub.store.publishBotMessage("alpha", { conversationId: a.id, status: "complete", blocks: [{ type: "text", text: "将当前对话移到列表首位" }] });
    const firstChat = sidebar.locator(".conversation-row").first();
    await expect(firstChat).toHaveAttribute("data-conversation-id", a.id);
    await firstChat.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^重命名/ }).click();
    const rename = page.getByRole("dialog", { name: "重命名对话", exact: true });
    await rename.getByRole("textbox", { name: "对话名称", exact: true }).fill("尚未提交的名称");
    await hub.store.publishBotMessage("beta", { conversationId: b.id, status: "complete", blocks: [{ type: "text", text: "另一对话触发重新排序" }] });
    await expect(firstChat).toHaveAttribute("data-conversation-id", b.id);
    await expect.poll(() => rename.evaluate(node => node.matches(":modal"))).toBe(true);
    await expect(rename.getByRole("textbox")).toHaveValue("尚未提交的名称");
    await rename.getByRole("textbox").press("Escape"); await expect(rename).toHaveCount(0);
    await expect(composer).toHaveValue("头像设置前的草稿");
    // The phone's details entry must keep its nested stack usable as well.
    await page.setViewportSize({ width: 390, height: 844 });
    await selectConversation(page, a.title); await openBotSettings(page); await edit(page);
    await editor(page).getByRole("button", { name: "选择星星猫头像", exact: true }).click();
    await hub.store.publishBotMessage("alpha", { conversationId: a.id, status: "complete", blocks: [{ type: "text", text: "手机选头像时收到更新" }] });
    await expect.poll(() => editor(page).evaluate(node => node.matches(":modal"))).toBe(true);
    await expect(editor(page).getByRole("button", { name: "保存头像", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("avatar-phone-update.png"), animations: "disabled" });
    await page.getByRole("button", { name: "关闭头像编辑", exact: true }).click(); await closeBotSettings(page);
    await expect(composer).toHaveValue("头像设置前的草稿"); await expect(composer).toBeEditable();
    expect(errors).toEqual([]);
  } finally { await page.close(); await other.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("mascot defaults stay stable and library/custom choices sync, conflict safely and restore on desktop and phone", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatar-library-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const dc = await browser.newContext(), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await dc.newPage(), phone = await pc.newPage();
  const errors: string[] = []; for (const page of [desktop, phone]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','精灵助手','fixture')");
    await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + "alpha", "pink-bunny"]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "头像验收", "avatar");
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "头像在消息、列表和设置里保持一致。" }] });
    await pair(desktop, hub); await pair(phone, hub); await selectConversation(phone, chat.title);
    const id = defaultBotAvatar("alpha", "pink-bunny").id;
    for (const page of [desktop, phone]) await expect(avatar(page)).toHaveAttribute("data-preset", id);
    for (const page of [desktop, phone]) {
      await expect(avatar(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expectCutouts(page, '[data-avatar="bot:alpha"] img');
    }
    await desktop.reload(); await waitForClientOnline(desktop); await expect(avatar(desktop)).toHaveAttribute("data-preset", id);
    for (const page of [desktop, phone]) await openBotSettings(page);
    for (const page of [desktop, phone]) await edit(page);
    const grid = editor(desktop).getByRole("group", { name: "系统头像", exact: true });
    await expect(grid.getByRole("button")).toHaveCount(BOT_AVATAR_LIBRARY.length);
    for (const page of [desktop, phone]) {
      const choices = editor(page).getByRole("group", { name: "系统头像", exact: true }).getByRole("button");
      await expect(choices).toHaveCount(BOT_AVATAR_LIBRARY.length);
      expect(await choices.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")))).toEqual(BOT_AVATAR_LIBRARY.map(avatar => `选择${avatar.name}头像`));
      // A persisted retired default still renders, but is not a selectable tile.
      for (const name of ["粉兔", "迷你柯基", "迷你可颂"]) await expect(editor(page).getByRole("button", { name: `选择${name}头像`, exact: true })).toHaveCount(0);
      await expect(editor(page).locator('.avatar-library button[aria-pressed="true"]')).toHaveCount(0);
      await expect(editor(page).locator('.avatar-library-preview [data-preset="pink-bunny"]')).toBeVisible();
      await expect(choices.first()).toHaveAttribute("tabindex", "0");
      await expect(choices.first()).toHaveAttribute("aria-label", "选择小凤凰头像");
      await expect(choices.nth(1)).toHaveAttribute("aria-label", "选择软糖粉兔头像");
      await expect(choices.first()).toBeInViewport();
      await expect(choices.nth(BOT_AVATAR_LIBRARY.findIndex(avatar => avatar.id === "mini-matcha"))).toHaveAttribute("aria-label", "选择迷你抹茶卷头像");
      await expect(choices.nth(BOT_AVATAR_LIBRARY.findIndex(avatar => avatar.id === "taro"))).toHaveAttribute("aria-label", "选择紫芋头像");
      await expect(choices.last()).toHaveAttribute("aria-label", "选择玫瑰方糖头像");
      await page.screenshot({ animations: "disabled", path: info.outputPath(page === desktop ? "library-new-first-desktop.png" : "library-new-first-phone.png") });
    }
    for (const page of [desktop, phone]) await expect.poll(() => editor(page).locator(".avatar-library > button").evaluateAll((buttons) => {
      const boxes = buttons.map((button) => button.getBoundingClientRect());
      return boxes.every((box, index) => { const prev = boxes[index - 1]; return box.width >= 40 && box.height >= 40 && (!prev || (box.left > prev.left ? box.left >= prev.right - 1 : box.top >= prev.bottom - 1)); });
    })).toBe(true);
    await expectCutouts(desktop, ".avatar-library img");
    // Every supplied tile must decode, not just the visible first row.
    await expect.poll(() => grid.locator("img").evaluateAll(async (images) => {
      await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
      return images.every((image) => {
        const portrait = image as HTMLImageElement;
        return portrait.naturalWidth === 256 && portrait.naturalHeight === 256 && new URL(portrait.src).pathname.endsWith(".webp");
      });
    })).toBe(true);
    await grid.getByRole("button", { name: "选择橘猫头像", exact: true }).click();
    await grid.getByRole("button", { name: "选择橘猫头像", exact: true }).press("Home");
    await expect(grid.getByRole("button", { name: "选择小凤凰头像", exact: true })).toBeFocused();
    await grid.getByRole("button", { name: "选择小凤凰头像", exact: true }).press("End");
    await expect(grid.getByRole("button", { name: "选择玫瑰方糖头像", exact: true })).toBeFocused();
    await grid.getByRole("button", { name: "选择玫瑰方糖头像", exact: true }).press("Enter");
    await expect(editor(desktop).locator(".avatar-library-preview strong")).toHaveText("玫瑰方糖");
    for (const name of ["小凤凰", "软糖粉兔", "薰衣考拉", "晴空象", "迷你鲸鱼", "迷你水母", "迷你抹茶卷"]) {
      await grid.getByRole("button", { name: `选择${name}头像`, exact: true }).click();
      await expect(editor(desktop).locator(".avatar-library-preview strong")).toHaveText(name);
    }
    await grid.getByRole("button", { name: "选择晴空象头像", exact: true }).click();
    await desktop.screenshot({ animations: "disabled", path: info.outputPath("library-desktop.png") });
    await desktop.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await desktop.screenshot({ animations: "disabled", path: info.outputPath("library-desktop-dark.png") });
    await desktop.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await editor(phone).getByRole("button", { name: "选择迷你抹茶卷头像", exact: true }).click();
    await phone.screenshot({ animations: "disabled", path: info.outputPath("library-phone.png") });
    await phone.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await phone.screenshot({ animations: "disabled", path: info.outputPath("library-phone-dark.png") });
    await phone.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await phone.setViewportSize({ width: 320, height: 740 });
    await expect(editor(phone).getByRole("button", { name: "保存头像", exact: true })).toBeInViewport();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => editor(phone).locator(".avatar-library > button").evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().width >= 44))).toBe(true);
    await phone.screenshot({ animations: "disabled", path: info.outputPath("library-phone-320.png") });
    await phone.setViewportSize({ width: 390, height: 844 });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(editor(phone).getByRole("button", { name: "保存头像", exact: true })).toBeInViewport();
    await save(desktop); await expect(editor(phone).getByRole("alert")).toContainText("另一台设备");
    await expect(editor(phone).getByRole("button", { name: "保存头像", exact: true })).toBeDisabled();
    await editor(phone).getByRole("button", { name: "保留选择，使用最新版本", exact: true }).click(); await save(phone);
    for (const page of [desktop, phone]) { await expect(avatar(page)).not.toHaveAttribute("data-preset"); await expect(avatar(page).locator("img")).toHaveAttribute("src", /^blob:/); }
    for (const page of [desktop, phone]) {
      await expectCutouts(page, '[data-avatar="bot:alpha"] img');
      await expect(avatar(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    const api = new HubAvatars(hub.store), first = await api.image("owner", { kind: "bot", id: "alpha" }, 2);
    expect(first.length).toBeLessThan(300 * 1024);
    // Cancel never writes; shuffle is explicit and cannot retain the same choice.
    await edit(desktop); await editor(desktop).getByRole("button", { name: "选择橘猫头像", exact: true }).click();
    await editor(desktop).getByRole("button", { name: "换一个", exact: true }).click();
    await expect(editor(desktop).getByRole("button", { name: "选择橘猫头像", exact: true })).toHaveAttribute("aria-pressed", "false");
    await editor(desktop).getByRole("button", { name: "取消", exact: true }).click();
    expect(await api.image("owner", { kind: "bot", id: "alpha" }, 2)).toEqual(first);
    await edit(desktop); await editor(desktop).getByRole("button", { name: "上传图片", exact: true }).click();
    await editor(desktop).getByLabel("选择头像图片", { exact: true }).setInputFiles({ name: "my-avatar.png", mimeType: "image/png", buffer: avatarFixture(400, 300, 110) });
    await expect(editor(desktop).getByLabel("头像裁剪预览")).toBeVisible(); await save(desktop);
    await expect.poll(async () => (await api.list("owner"))[0]?.revision).toBe(3);
    await edit(phone); phone.once("dialog", (dialog) => dialog.accept()); await editor(phone).getByRole("button", { name: "恢复系统头像", exact: true }).click();
    for (const page of [desktop, phone]) await expect(avatar(page)).toHaveAttribute("data-preset", id);
    expect((await api.list("owner"))[0]).toMatchObject({ revision: 4, hasImage: false });
    expect(errors).toEqual([]);
  } finally { await dc.close(); await pc.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
