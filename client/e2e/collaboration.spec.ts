import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { readRegistry } from "../../src/bus/bus-registry.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

test("paired devices edit native collaboration with conflict protection, role selection and real idle restarts", async ({ page, browser }, info) => {
  // Five worker boots, pairing two devices and two real restarts share this
  // budget. Keep each worker/restart's existing 15-second deadline intact.
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "client-collaboration-")), home = path.join(root, "home"); await mkdir(home);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { PATH: process.env.PATH, HOME: home, CODEX_EXECUTABLE: process.execPath } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  const errors: string[] = []; for (const device of [page, phone]) device.on("pageerror", (error) => errors.push(error.message));
  async function pair(device: Page) {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(device); await openWorkspacePage(device, "运行状态");
    await device.locator(".operation-bot").filter({ hasText: "协调助手" }).getByRole("button", { name: "协作设置", exact: true }).click();
    await expect(device.getByLabel("启用多 Bot 协作", { exact: true })).toBeVisible();
  }
  try {
    const bots = [];
    for (const [i, name] of ["协调助手", "研究助手", "分析助手", "写作助手", "复核助手"].entries()) bots.push(await hub.botManager!.create("owner", { requestId: `collaboration_${i}`, name, engine: "codex", model: "", effort: "", workspace: "" }));
    const [main, beta, gamma, delta, epsilon] = bots;
    await expect.poll(async () => (await hub.store.bots("owner")).filter((bot) => bot.online).length, { timeout: 15000 }).toBe(5);
    await pair(page); await pair(phone);
    await page.getByLabel("启用多 Bot 协作", { exact: true }).check();
    for (const peer of bots.slice(1)) await page.getByRole("checkbox", { name: peer.name, exact: true }).check();
    await page.getByRole("combobox", { name: "添加到并行询问", exact: true }).selectOption(beta!.id);
    for (const bot of [beta!, gamma!]) await page.getByRole("combobox", { name: "添加到串联步骤", exact: true }).selectOption(bot.id);
    await page.getByRole("button", { name: "上移 分析助手", exact: true }).click();
    await page.getByRole("combobox", { name: "复核 Bot", exact: true }).selectOption(epsilon!.id);
    await page.getByText("研究团队与高级设置", { exact: true }).click(); await page.getByLabel("启用 Crew 研究团队", { exact: true }).check();
    await expect(page.locator(".collaboration-panel")).toContainText("普通文字消息");
    // Duplicate roles disable save, rather than silently normalizing the native workflow.
    await page.getByRole("combobox", { name: "分析员", exact: true }).selectOption(beta!.id); await expect(page.getByRole("button", { name: "保存协作设置" })).toBeDisabled();
    await page.getByRole("combobox", { name: "研究员", exact: true }).selectOption(beta!.id); await page.getByRole("combobox", { name: "分析员", exact: true }).selectOption(gamma!.id);
    await page.getByRole("combobox", { name: "撰写者", exact: true }).selectOption(delta!.id); await page.getByRole("combobox", { name: "审阅者", exact: true }).selectOption(epsilon!.id);
    await page.getByRole("button", { name: "保存协作设置", exact: true }).click(); await expect(page.getByRole("status")).toContainText("协作设置已保存");
    const file = path.join(root, "hub", "bots", main!.id, "config.json"), config = JSON.parse(await readFile(file, "utf8"));
    expect(config.bus.chain).toEqual([gamma!.id, beta!.id]); expect(config.bus.crew.roles).toEqual({ researcher: beta!.id, analyst: gamma!.id, writer: delta!.id, reviewer: epsilon!.id });
    expect(await page.locator(".collaboration-panel").innerText()).not.toContain(config.bus.secret);
    // The phone still owns the earlier revision. Its attempted save must fail.
    await phone.getByText("研究团队与高级设置", { exact: true }).click(); await phone.getByLabel("最大委派层数", { exact: true }).fill("2");
    await phone.getByRole("button", { name: "保存协作设置", exact: true }).click(); await expect(phone.getByRole("alert")).toContainText("另一台设备或本机配置已更新");
    await expect(phone.getByLabel("最大委派层数", { exact: true })).toHaveValue("2");
    phone.once("dialog", (dialog) => { void dialog.dismiss(); }); await phone.locator(".settings-page-back").click(); await expect(phone.locator(".collaboration-panel")).toBeVisible();
    phone.once("dialog", (dialog) => { void dialog.accept(); }); await phone.getByRole("button", { name: "重新读取配置", exact: true }).click();
    await expect(phone.getByLabel("启用 Crew 研究团队", { exact: true })).toBeChecked(); await expect(phone.getByLabel("最大委派层数", { exact: true })).toHaveValue("3");
    await expect(phone.getByRole("combobox", { name: "复核 Bot", exact: true })).toHaveValue(epsilon!.id);
    // Save alone never restarts the service. This deliberate second action uses
    // the existing deferred restart path and a real Gateway worker/Bus listener.
    expect(Object.keys((await readRegistry(path.join(root, "hub", "bots"))).instances)).toHaveLength(0);
    await page.getByRole("button", { name: "空闲后重启并应用", exact: true }).click(); await expect(page.getByRole("status")).toContainText("已安排空闲后重启");
    await expect.poll(async () => !!(await readRegistry(path.join(root, "hub", "bots"))).instances[main!.id], { timeout: 15000 }).toBe(true);
    await phone.getByRole("button", { name: "配置 研究助手", exact: true }).click();
    await phone.getByLabel("启用多 Bot 协作", { exact: true }).check(); await phone.getByRole("checkbox", { name: "协调助手", exact: true }).check();
    await phone.getByRole("button", { name: "保存协作设置", exact: true }).click(); await expect(phone.getByRole("status")).toContainText("协作设置已保存");
    await phone.getByRole("button", { name: "空闲后重启并应用", exact: true }).click();
    await expect.poll(async () => !!(await readRegistry(path.join(root, "hub", "bots"))).instances[beta!.id], { timeout: 15000 }).toBe(true);
    await page.getByRole("button", { name: "重新读取配置", exact: true }).click();
    await expect(page.locator(".collaboration-peer").filter({ hasText: "研究助手" })).toContainText("对方已允许此 Bot");
    await expect(page.locator(".collaboration-peer").filter({ hasText: "研究助手" })).toContainText("协作服务在线");
    await phone.getByRole("button", { name: "配置 协调助手", exact: true }).click();
    // Anonymous requests cannot read this owner-only configuration.
    const anonymous = await fetch(`${hub.url}/api/bots/${main!.id}/collaboration`); expect(anonymous.status).toBe(401);
    for (const device of [page, phone]) {
      expect(await device.locator(".operations-panel").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await device.locator(".operations-panel").evaluate((el) => { el.scrollTop = 0; });
      await device.screenshot({ path: info.outputPath(device === page ? "collaboration-desktop.png" : "collaboration-phone.png") });
    }
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
