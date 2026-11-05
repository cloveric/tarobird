import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, mobileHome, waitForClientOnline } from "./fixtures/mobile.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });
let root: string, hub: HubServer;
const namedHosts = new WeakSet<HubServer>();
const settings = (page: Page) => page.getByRole("dialog", { name: "Bot 设置", exact: true });
const editor = (page: Page) => page.getByRole("dialog", { name: "修改 Bot 名称", exact: true });
async function pair(page: Page, target = hub, name = "测试主机", add = false) {
  // Hosts now initialize their real machine name at startup. Seed each fixture
  // once before pairing, and keep its name when another device joins it.
  if (!namedHosts.has(target)) {
    await target.store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
    namedHosts.add(target);
  }
  if (add) await clickAppAction(page, "连接另一台主机"); else await page.goto(target.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(target.url);
  await preparePairing(page, target); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await target.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page);
}
async function openDesktop(page: Page, botId = "alpha", host?: string) {
  const workspace = page.locator(".host-workspace:not([hidden])");
  const scope = host ? workspace.getByRole("region", { name: `主机：${host}`, exact: true }) : workspace;
  await scope.locator(`[data-bot-id="${botId}"] .bot-identity`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
}
async function begin(page: Page, value: string) {
  await settings(page).getByRole("button", { name: "修改 Bot 名称", exact: true }).click();
  await expect(editor(page).getByLabel("Bot 名称", { exact: true })).toBeFocused();
  await editor(page).getByLabel("Bot 名称", { exact: true }).fill(value);
}
async function save(page: Page) {
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
}
test.beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-name-ui-"));
  hub = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','未建对话的 Bot','fixture')");
  await hub.store.createConversation("owner", ["alpha"], "旅行计划", "chat");
});
test.afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

test("desktop and phone rename an offline Bot, synchronize names and retain avatars and chat titles", async ({ page, browser }, info) => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  try {
    await pair(page); await pair(phone);
    await mobileHome(phone).getByRole("navigation").getByRole("button", { name: "Bot", exact: true }).tap();
    await mobileHome(phone).getByRole("button", { name: "研究助手 的 Bot 设置", exact: true }).tap();
    await openDesktop(page);
    const avatar = settings(page).locator('[data-avatar="bot:alpha"]');
    const preset = await avatar.getAttribute("data-preset");
    await expect(settings(page)).toContainText("Bot 当前离线");
    await page.screenshot({ path: info.outputPath("bot-name-settings-desktop.png"), animations: "disabled" });
    await begin(page, "研究伙伴");
    await page.screenshot({ path: info.outputPath("bot-name-editor-desktop.png"), animations: "disabled" });
    await save(page);
    await expect(settings(page).getByRole("button", { name: "修改 Bot 名称", exact: true })).toBeFocused();
    await expect(settings(phone).locator(".bot-name-setting strong")).toHaveText("研究伙伴");
    await expect(avatar).toHaveAttribute("data-preset", preset!);
    await begin(phone, "我的研究伙伴");
    await phone.screenshot({ path: info.outputPath("bot-name-editor-phone.png"), animations: "disabled" });
    const box = (await editor(phone).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(844);
    await save(phone);
    await expect(settings(page).locator(".bot-name-setting strong")).toHaveText("我的研究伙伴");
    expect((await hub.store.conversations("owner"))[0]!.title).toBe("旅行计划");
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator('.host-workspace:not([hidden]) [data-bot-id="alpha"] .bot-identity')).toContainText("我的研究伙伴");
    await openDesktop(page, "beta"); await begin(page, "写作伙伴"); await save(page);
    expect(await hub.store.botName("owner", "beta")).toEqual({ name: "写作伙伴" });
    expect(await hub.store.conversations("owner")).toHaveLength(1);
  } finally { await phone.close(); }
});

test("another device's rename preserves the open draft until the user reloads the current name", async ({ page, browser }) => {
  const other = await browser.newPage({ serviceWorkers: "block" });
  try {
    await pair(page); await pair(other); await openDesktop(page); await openDesktop(other);
    await begin(page, "我的草稿"); await begin(other, "另一台设备的新名称"); await save(other);
    await expect(editor(page).getByRole("alert")).toContainText("名称已在其他设备修改");
    await expect(editor(page).getByLabel("Bot 名称", { exact: true })).toHaveValue("我的草稿");
    await expect(editor(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await editor(page).getByRole("button", { name: "读取最新名称", exact: true }).click();
    await expect(editor(page).getByLabel("Bot 名称", { exact: true })).toHaveValue("另一台设备的新名称");
    await editor(page).getByLabel("Bot 名称", { exact: true }).fill(" ");
    await expect(editor(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await editor(page).getByLabel("Bot 名称", { exact: true }).fill("最后的名称"); await save(page);
    await expect(settings(other).locator(".bot-name-setting strong")).toHaveText("最后的名称");
  } finally { await other.close(); }
});

test("late save receipts cannot overwrite a newer name or rename the same Bot ID on another host", async ({ page, browser }) => {
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [hub.url] });
  const other = await browser.newPage({ serviceWorkers: "block" });
  let release!: () => void;
  const receipt = new Promise<void>(resolve => { release = resolve; });
  try {
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    await pair(page, hub, "主机甲"); await pair(page, b, "主机乙", true); await pair(other);
    await setListOption(page, '按主机分组', true);
    await openDesktop(page, "alpha", "主机甲"); await openDesktop(other);
    await page.route(`${hub.url}/api/bots/alpha/name`, async route => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      const response = await route.fetch(); await receipt; await route.fulfill({ response });
    });
    await begin(page, "第一版名称"); await editor(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings(other).locator(".bot-name-setting strong")).toHaveText("第一版名称");
    await expect(editor(page).getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await expect(editor(page).getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(editor(page)).toBeVisible();
    await begin(other, "最新名称"); await save(other); release();
    await expect(editor(page)).toHaveCount(0);
    await expect(settings(page).locator(".bot-name-setting strong")).toHaveText("最新名称");
    expect(await b.store.botName("owner", "alpha")).toEqual({ name: "研究助手" });
    await hub.close();
    await expect(settings(page).getByRole("button", { name: "修改 Bot 名称", exact: true })).toBeDisabled();
  } finally { release(); await other.close(); await b.close(); }
});
