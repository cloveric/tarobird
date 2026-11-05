import { preparePairing } from "./fixtures/pairing-invite.js";
import { openWorkspacePage, selectConversation } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { recordUncleanBootAndCheck } from "../../src/runtime/restart-loop-guard.js";
import { gatewayRestartFixture } from "../../tests/helpers/gateway-restart-fixture.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
test("both devices can inspect a standalone recovery pause and continue sending local commands", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-restart-guard-")), stateDir = path.join(root, "bot"), home = path.join(root, "home");
  await mkdir(stateDir); await mkdir(home);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(), errors: string[] = [];
  for (const p of [desktop, phone]) p.on("pageerror", (error) => errors.push(error.message));
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','恢复保护助手',?)", [hashSecret(secret)]);
    await hub.store.createConversation("owner", ["alpha"], "恢复后的对话", "create");
    for (let i = 0; i < 3; i++) await recordUncleanBootAndCheck(stateDir);
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "kill" }, home);
    await expect.poll(() => fixture!.messages, { timeout: 15000 }).toContain("boot-complete");
    expect(fixture.messages).not.toContain("maintenance");
    for (const p of [desktop, phone]) {
      await pair(p, hub);
      await openWorkspacePage(p, "运行状态");
      await p.getByRole("button", { name: "运行记录", exact: true }).click();
      await p.getByLabel("记录来源", { exact: true }).selectOption("audit"); await p.getByRole("button", { name: "应用筛选", exact: true }).click();
      await expect(p.locator(".diagnostic-event")).toHaveCount(1);
      await expect(p.locator(".diagnostic-event")).toContainText("已暂缓本次启动恢复");
      await p.locator(".diagnostic-event").getByText("查看记录详情", { exact: true }).click();
      await expect(p.locator(".diagnostic-event pre")).toContainText('"uncleanBoots":3');
      await p.screenshot({ path: info.outputPath(`restart-guard-${p === phone ? "phone" : "desktop"}.png`) });
      if (p === phone) { await p.locator(".settings-page-back").click(); await p.locator(".settings-page-back").click(); }
      else await p.getByRole("button", { name: "关闭运行状态", exact: true }).click();
      if (p === phone) await selectConversation(p, "恢复后的对话");
    }
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("/help");
    await phone.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const p of [desktop, phone]) {
      await expect(p.locator(".message-blocks").filter({ hasText: "TaroBird App" })).toBeVisible();
      expect(await p.locator(".app-shell").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    // A timed-out page may already be closed; it must not prevent child cleanup.
    await Promise.all([desktopContext.close().catch(() => {}), phoneContext.close().catch(() => {}), fixture?.kill()]);
    try { await hub.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
