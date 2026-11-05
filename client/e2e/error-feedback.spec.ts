import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

for (const failure of ["policy", "effort"] as const) for (const locale of ["zh", "en"] as const) test(`${failure} failure is actionable on both clients without replay; next input succeeds (${locale})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-error-feedback-"));
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: failure === "effort" ? "antigravity" : "deepseek", locale }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const calls: string[] = [], pageErrors: string[] = [];
  const runtime = createCoreServiceRuntime(); let gateway: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','错误反馈验收',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "错误后的继续对话", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: failure === "effort" ? "antigravity" : "deepseek", runtime,
      bridge: { handleAuthorizedMessage: async input => {
        const key = input.text.includes("继续正常问题") ? "continue" : "reject"; calls.push(key);
        if (key === "reject") throw new Error(failure === "policy" ? "DeepSeek Harness agent failed: Content Exists Risk (request_id: fixture-provider-id)" : 'Antigravity emitted result before init\nerror: invalid model selection (--model "" --effort "xhigh"): gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)');
        return { text: locale === "zh" ? "新的问题已正常完成。" : "The next request completed normally." };
      } } });
    for (const page of [desktop, phone]) {
      page.on("pageerror", error => pageErrors.push(error.message));
      await pair(page, hub); await selectConversation(page, chat.title);
    }
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("普通验收问题");
    await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    const errorText = failure === "effort" ? (locale === "zh" ? "不支持 xhigh" : "does not support xhigh") : locale === "zh" ? "本轮被模型的内容安全策略拦截" : "the model's content-safety policy blocked this turn";
    for (const page of [desktop, phone]) {
      const feedback = page.locator(".message-body").filter({ hasText: errorText });
      await expect(feedback).toBeVisible();
      await expect(feedback).toContainText(failure === "effort" ? (locale === "zh" ? "无需重启" : "no restart is needed") : locale === "zh" ? "重启实例无效" : "restarting the instance will not help");
      await expect(feedback).not.toContainText("fixture-provider-id");
      expect(await page.locator("body").innerHTML()).not.toContain("fixture-provider-id");
      await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
    }
    await expect.poll(() => runtime.activeRuns.size).toBe(0);
    expect(calls).toEqual(["reject"]);
    expect(JSON.stringify((await hub.store.snapshot("owner", chat.id)).messages)).not.toContain("fixture-provider-id");
    await phone.reload(); await waitForClientOnline(phone); await selectConversation(phone, chat.title);
    await expect(phone.locator(".message-body").filter({ hasText: errorText })).toBeVisible();
    expect(await phone.locator("body").innerHTML()).not.toContain("fixture-provider-id");
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("继续正常问题");
    await phone.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const page of [desktop, phone]) await expect(page.getByText(locale === "zh" ? "新的问题已正常完成。" : "The next request completed normally.", { exact: true })).toBeVisible();
    await expect.poll(() => runtime.activeRuns.size).toBe(0);
    expect(calls).toEqual(["reject", "continue"]); expect(pageErrors).toEqual([]);
    await phone.screenshot({ path: info.outputPath(`${failure}-feedback-${locale}-phone.png`) });
  } finally {
    await desktopContext.close().catch(() => {}); await phoneContext.close().catch(() => {});
    try { await gateway?.disconnect(); } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
  }
});
