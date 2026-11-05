import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { UsageStore } from "../../src/state/usage-store.js";

test("operations preserves recorded totals and distinguishes unreported tokens and costs", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-ops-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const channels: GatewayChannel[] = [];
  try {
    for (const engine of ["kimi", "deepseek", "claude", "codex"]) {
      const stateDir = path.join(root, engine); await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "zh" }));
      const usage = new UsageStore(stateDir);
      if (engine === "kimi") { await usage.recordUnmetered(); await usage.recordUnmetered(); }
      if (engine === "deepseek") await usage.record({ inputTokens: 1000, outputTokens: 500 });
      if (engine === "claude") await usage.record({ inputTokens: 2000, outputTokens: 300, costUsd: 0.125 });
      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [engine, `${engine} Bot`, hashSecret(secret)]);
      channels.push(await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: engine, engine, secret,
        runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } }));
    }
    await expect.poll(async () => (await hub.store.bots("owner")).filter((bot) => bot.online).length).toBe(4);
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await clickAppAction(page, "运行状态", page.getByRole("button", { name: "运行状态", exact: true }));
    const bot = (engine: string) => page.locator(".operation-bot").filter({ has: page.getByText(`${engine} Bot`, { exact: true }) });
    await expect(bot("kimi")).toContainText("token 用量未知 · 费用未知 · 2 次用量未知");
    await expect(bot("kimi")).not.toContainText("0 tokens");
    await expect(bot("deepseek")).toContainText("1,500 tokens · 费用未知");
    await expect(bot("deepseek")).toContainText("美元预算无法约束其消耗");
    await expect(bot("claude")).toContainText("2,300 tokens · $0.1250");
    await expect(bot("codex")).toContainText("token 用量未知 · 费用未知");
    // Retain earlier-engine measurements when the same Bot now uses Kimi.
    await new UsageStore(path.join(root, "kimi")).record({ inputTokens: 50, outputTokens: 10, costUsd: 0.01 });
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(bot("kimi")).toContainText("60 tokens · $0.0100 · 2 次用量未知");
    await expect(bot("kimi")).toContainText("累计记录不包含未上报的用量或费用");
    await page.screenshot({ path: info.outputPath("operations-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("dialog", { name: "运行状态" })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("operations-phone.png") });
    await page.getByRole("button", { name: "查看 Hub 审计", exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新状态", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(page.getByRole("button", { name: "刷新状态", exact: true })).toBeVisible();
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(page.getByRole("dialog", { name: "运行状态" })).toHaveCount(0);
  } finally { for (const channel of channels) await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
