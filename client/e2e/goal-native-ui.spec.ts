import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import type { ClaudeNativeGoalReceipt } from "../../src/codex/claude-native-goal.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}

// Real Core -> Gateway -> Hub -> App rendering; engine receipts are synthetic.
for (const width of [390, 1360]) test(`Claude goal turn end stays distinct from success at ${width}px`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-ui-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  let gateway: GatewayChannel | undefined;
  let nativeState: ClaudeNativeGoalReceipt["state"] = "active";
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 目标验收',?,'claude')", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "目标状态展示", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async value => {
        if (!value.text.startsWith("/goal")) return { text: "普通回复完成。" };
        value.onNativeGoal?.({ state: "accepted", objective: "检查示例" });
        return { text: "已记录本轮结果。", nativeGoal: { command: "set", acknowledged: true, state: nativeState, objective: "检查示例", verifiedBy: ["command", "query"] } };
      },
    } });
    await page.setViewportSize({ width, height: 844 }); await pair(page, hub); await enterMobileChat(page, chat.title);
    for (const state of ["active", "none", "unverified"] as const) {
      nativeState = state;
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(`/goal 检查示例 ${state}`);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const run = page.locator(".native-run").last();
      await expect(run.locator(".native-run-status")).toContainText("本轮已结束");
      await expect(run.locator(".native-run-status")).not.toContainText("已完成");
      await expect(run.locator(".native-run-prose")).toContainText(state === "active" ? "目标仍保留" : state === "none" ? "不代表已确认达成" : "未核实");
    }
    await page.getByRole("button", { name: "查看运行过程", exact: true }).last().click();
    await expect(page.locator(".run-details-phase")).toHaveText("本轮已结束");
    await page.getByRole("button", { name: "关闭运行过程" }).click();
    await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
    await expect(page.locator(".native-run-status").last()).toContainText("本轮已结束");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("普通消息");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".native-run-status").last()).toContainText("已完成");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
