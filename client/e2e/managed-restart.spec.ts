import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Request } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" }); // Keep injected HTTP errors on the page request.
test("a managed worker confirms a UI restart, deduplicates its HTTP replay and shows uncertain results truthfully", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-managed-restart-")), home = path.join(root, "home"); await mkdir(home);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { PATH: process.env.PATH, HOME: home, CODEX_EXECUTABLE: process.execPath } } });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    const bot = await hub.botManager!.create("owner", { requestId: "ui_restart", name: "托管验收助手", engine: "codex", model: "", effort: "", workspace: "" });
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online, { timeout: 15000 }).toBe(1);
    const pid = () => Number(hub.botManager!.serviceStatus(bot.id).text.match(/PID: (\d+)/)?.[1] ?? 0);
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await clickAppAction(page, "运行状态", page.getByRole("button", { name: "运行状态", exact: true }));
    await expect(page.getByText("托管验收助手", { exact: true }).last()).toBeVisible();
    let request: Request | undefined;
    page.on("request", (value) => { if (new URL(value.url()).pathname === `/api/bots/${bot.id}/restart`) request = value; });
    const originalPid = pid(); expect(originalPid).toBeGreaterThan(1);
    page.once("dialog", (dialog) => { void dialog.accept(); });
    await page.getByRole("button", { name: "空闲后重启", exact: true }).click();
    await expect(page.locator(".operation-log")).toContainText("已安排空闲后重启");
    await expect.poll(() => pid() > 1 && pid() !== originalPid, { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online, { timeout: 15000 }).toBe(1);
    const secondPid = pid(); expect(request).toBeDefined();
    // Repeat the identical authenticated request after the new process is live.
    const replay = await fetch(request!.url(), { method: "POST", headers: request!.headers(), body: request!.postData() });
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ ok: true, result: { text: "已安排空闲后重启" } });
    // Allow the idle-exit (250 ms) and supervisor restart (500 ms) to run if
    // receipt reuse accidentally dispatches another control message.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(pid()).toBe(secondPid);
    // A subsequent uncertain action must clear the old successful receipt.
    await page.route(`**/api/bots/${bot.id}/restart`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "restart_confirmation_unavailable" }) }));
    page.once("dialog", (dialog) => { void dialog.accept(); }); await page.getByRole("button", { name: "空闲后重启", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("重启结果尚未确认。请先检查服务状态，再决定是否重试。");
    await expect(page.locator(".operation-log")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("managed-restart-uncertain.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("managed-restart-uncertain-phone.png") });
    expect(errors).toEqual([]);
  } finally { await page.close().catch(() => {}); try { await hub.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
