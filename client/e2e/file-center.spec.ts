import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openWorkspacePage, selectConversation } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings } from "./fixtures/settings.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
test("desktop and phone share file labels, retain conflicting drafts and render readable light/dark views", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-files-")), workspace = path.join(root, "workspace");
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const channels: GatewayChannel[] = [];
  // Page routing must own the save barrier; an installed service worker can
  // bypass Playwright's interception on WebKit. Offline reload has its own test.
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const errors: string[] = []; for (const p of [desktop, phone]) p.on("pageerror", (e) => errors.push(e.message));
  try {
    for (const [folder, file, size] of [["outputs", "交付说明.md", 12000], ["research", "研究资料.csv", 24000], [".cache", "模型缓存.bin", 100000], [".tarobot-files", "input.txt", 10], [".tarobot-out", "result.txt", 10], [".lark-files", "old-input.txt", 10], [".lark-out", "old-result.txt", 10]] as const) {
      await mkdir(path.join(workspace, folder), { recursive: true }); await writeFile(path.join(workspace, folder, file), Buffer.alloc(size, 65));
      const old = new Date("2024-01-01T00:00:00Z"); await utimes(path.join(workspace, folder, file), old, old); await utimes(path.join(workspace, folder), old, old);
    }
    await mkdir(path.join(root, "outside")); await writeFile(path.join(root, "outside", "private.txt"), "Private data"); await symlink(path.join(root, "outside"), path.join(workspace, "outside-link"));
    for (const [id, name] of [["alpha", "研究助手"], ["beta", "写作助手"]]) {
      const stateDir = path.join(root, id!); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", workspacePath: workspace }));
      const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id!, name!, hashSecret(secret)]);
      channels.push(await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: id!, secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } }));
    }
    for (const page of [desktop, phone]) {
      await pair(page, hub);
      await openWorkspacePage(page, "文件中心");
      await expect(page.locator(".file-unit")).toHaveCount(8);
      for (const label of ["收到的附件", "生成文件", "收到的附件（旧目录）", "生成文件（旧目录）"]) await expect(page.locator(".file-unit strong").getByText(label, { exact: true })).toBeVisible();
      await expect(page.locator(".file-center-list")).not.toContainText(".lark-");
      await page.locator(".file-unit").filter({ hasText: "收到的附件（旧目录）" }).click();
      await expect(page.getByLabel("文件组详情")).toContainText(path.join(workspace, ".lark-files"));
      await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
      await page.locator(".file-unit").filter({ hasText: "outputs" }).click();
      await expect(page.getByLabel("文件组详情")).toContainText("研究助手、写作助手");
    }
    expect((await hub.fileCenter.status()).inventory!.units.filter((u) => u.name === "outputs")).toHaveLength(1);
    await desktop.bringToFront(); await desktop.getByLabel("文件备注", { exact: true }).fill("电脑填写的交付备注");
    await desktop.locator(".file-unit").filter({ hasText: "outputs" }).click();
    desktop.once("dialog", (dialog) => { void dialog.dismiss(); });
    await desktop.getByRole("button", { name: "关闭文件中心", exact: true }).click();
    await expect(desktop.getByLabel("文件备注", { exact: true })).toHaveValue("电脑填写的交付备注");
    let releaseSave!: () => void, saveHeld = false;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    await desktop.route("**/api/files/labels", async (route) => { saveHeld = true; await saveGate; await route.continue(); }, { times: 1 });
    try {
      await desktop.getByRole("button", { name: "保存标注", exact: true }).click();
      await expect.poll(() => saveHeld).toBe(true);
      await expect(desktop.getByLabel("文件备注", { exact: true })).toBeDisabled();
      await expect(desktop.getByLabel("手动分类", { exact: true })).toBeDisabled();
      await expect(desktop.getByLabel("标记为重要", { exact: true })).toBeDisabled();
      expect(await desktop.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
      await desktop.getByRole("button", { name: "关闭文件中心", exact: true }).click();
      await expect(desktop.getByLabel("文件组详情")).toBeVisible();
    } finally { releaseSave(); }
    await expect(desktop.getByText("标注已保存，两端共享。", { exact: true })).toBeVisible();
    await expect(desktop.getByLabel("文件备注", { exact: true })).toBeEnabled();
    await phone.bringToFront(); await expect(phone.getByLabel("文件备注", { exact: true })).toHaveValue("电脑填写的交付备注");
    await phone.getByLabel("文件备注", { exact: true }).fill("手机尚未保存的草稿");
    await desktop.bringToFront(); await desktop.getByLabel("文件备注", { exact: true }).fill("桌面已经更新的备注"); await desktop.getByRole("button", { name: "保存标注", exact: true }).click();
    await expect(desktop.getByRole("button", { name: "保存标注", exact: true })).toBeDisabled();
    await phone.bringToFront(); await expect(phone.getByText("另一台设备有新标注，你的草稿仍保留。", { exact: true })).toBeVisible();
    await expect(phone.getByLabel("文件备注", { exact: true })).toHaveValue("手机尚未保存的草稿");
    await phone.getByRole("button", { name: "保存标注", exact: true }).click();
    await expect(phone.getByRole("alert")).toContainText("另一台设备已修改标注");
    await phone.getByRole("button", { name: "读取最新标注", exact: true }).click();
    await expect(phone.getByLabel("文件备注", { exact: true })).toHaveValue("桌面已经更新的备注");
    await phone.getByLabel("文件备注", { exact: true }).fill("两端共享的最终标注"); await phone.getByLabel("标记为重要", { exact: true }).check(); await phone.getByLabel("手动分类", { exact: true }).selectOption("source");
    await phone.getByRole("button", { name: "保存标注", exact: true }).click(); await expect(phone.getByRole("button", { name: "保存标注", exact: true })).toBeDisabled();
    await desktop.bringToFront(); await expect(desktop.getByLabel("文件备注", { exact: true })).toHaveValue("两端共享的最终标注");
    await expect(desktop.getByLabel("标记为重要", { exact: true })).toBeChecked(); await expect(desktop.getByLabel("手动分类", { exact: true })).toHaveValue("source");
    await desktop.locator(".file-details").evaluate((e) => { e.scrollTop = 0; }); await desktop.screenshot({ path: info.outputPath("file-center-desktop-light.png") });
    expect(await phone.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true); await expect(phone.getByLabel("文件组详情")).toHaveCount(0); await phone.getByLabel("文件状态", { exact: true }).selectOption("important"); await phone.getByLabel("所属 Bot", { exact: true }).selectOption("beta");
    await expect(phone.locator(".file-unit")).toHaveCount(1); await phone.screenshot({ path: info.outputPath("file-center-phone-list.png") });
    await phone.locator(".file-unit").click(); await phone.locator(".file-details").evaluate((e) => { e.scrollTop = 0; }); await phone.screenshot({ path: info.outputPath("file-center-phone-light.png") });
    for (const p of [desktop, phone]) expect(await p.locator(".file-center").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await desktop.getByRole("button", { name: "关闭文件中心", exact: true }).click();
    await openSettings(desktop, "general"); await desktop.getByLabel("主题", { exact: true }).selectOption("dark"); await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await clickAppAction(desktop, "文件中心", desktop.getByRole("button", { name: "文件中心", exact: true })); await desktop.locator(".file-unit").filter({ hasText: "outputs" }).click(); await desktop.screenshot({ path: info.outputPath("file-center-desktop-dark.png") });
    await desktop.getByRole("button", { name: "关闭文件中心", exact: true }).click(); await openSettings(desktop, "general"); await desktop.getByLabel("语言", { exact: true }).selectOption("en"); await desktop.getByRole("button", { name: "Close settings", exact: true }).click();
    await clickAppAction(desktop, "File center"); await desktop.locator(".file-unit").filter({ hasText: "outputs" }).click(); await expect(desktop.getByLabel("File note", { exact: true })).toHaveValue("两端共享的最终标注");
    await expect(desktop.getByText("Space on disk", { exact: true }).first()).toBeVisible();
    expect(await readFile(path.join(workspace, "outputs", "交付说明.md"))).toEqual(Buffer.alloc(12000, 65));
    expect(errors).toEqual([]);
  } finally { await desktopContext.close(); await phoneContext.close(); for (const channel of channels) await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
