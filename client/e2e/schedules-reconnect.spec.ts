import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { CronStore } from "../../src/state/cron-store.js";
import { CronScheduler } from "../../src/runtime/cron-scheduler.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}

// C-14: Cron and timezone are identifiers, so the phone keyboard must not
// capitalize or autocorrect them; and a connection blip must not blank the
// task list while it rereads it.
test("phone schedules keep identifier fields literal and the list through a reconnect", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "schedules-reconnect-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", timezone: "Asia/Shanghai" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手',?)", [hashSecret(secret)]);
  const runtime = createCoreServiceRuntime();
  const gateway = await attachGateway({ stateDir, botId: "alpha", secret, url: hub.url.replace("http", "ws") + "/instance", runtime, bridge: { handleAuthorizedMessage: async () => ({ text: "scheduled fixture reply" }) } });
  const store = new CronStore(stateDir), scheduler = new CronScheduler({ store, stateDir, executor: (job, signal) => gateway.runCron!(job, signal) }); await scheduler.start(); runtime.cronRuntime = { store, scheduler };
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/ws", route => { socket = route; route.connectToServer(); });
  try {
    await pair(page, hub); await openWorkspacePage(page, "定时任务");
    const panel = page.locator(".scheduled-tasks");
    await expect(panel.getByText("尚未创建定时任务。", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "新建定时任务", exact: true }).click();
    await panel.getByLabel("任务名称", { exact: true }).fill("工作日早报");
    await panel.getByLabel("任务内容", { exact: true }).fill("整理昨天的项目进展。");
    await panel.getByLabel("执行频率", { exact: true }).selectOption("custom");
    for (const name of ["Cron 表达式", "任务时区"]) {
      const field = panel.getByLabel(name, { exact: true });
      await expect(field).toHaveAttribute("autocapitalize", "off");
      await expect(field).toHaveAttribute("autocorrect", "off");
      await expect(field).toHaveAttribute("spellcheck", "false");
    }
    const timezone = panel.getByLabel("任务时区", { exact: true });
    expect(await timezone.evaluate((input: HTMLInputElement) => [...(input.list?.options ?? [])].some(option => option.value === "Asia/Shanghai"))).toBe(true);
    await panel.getByLabel("Cron 表达式", { exact: true }).fill("0 9 * * 1-5");
    await timezone.fill("Asia/Shanghai");
    await panel.getByRole("button", { name: "创建定时任务", exact: true }).click();
    await expect(panel.getByText("定时任务已保存。", { exact: true })).toBeVisible();
    const item = panel.locator(".schedule-item");
    await expect(item).toHaveCount(1); await expect(item).toContainText("工作日早报");
    // Hold the reread that follows the reconnect so the list is observed
    // while it is still outstanding.
    let reads = 0, release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/bots/alpha/schedules", async route => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      reads++; await held; await route.continue();
    });
    const previous = socket!; await previous.close({ code: 4000, reason: "fixture blip" });
    await expect.poll(() => socket !== previous).toBe(true);
    await waitForClientOnline(page);
    await expect.poll(() => reads).toBe(1);
    await expect(item).toHaveCount(1); await expect(item).toContainText("工作日早报");
    release();
    await expect(panel.getByRole("status").filter({ hasText: "正在读取定时任务…" })).toHaveCount(0);
    await expect(item).toHaveCount(1); expect(reads).toBe(1);
  } finally { await page.close(); await scheduler.stop(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
