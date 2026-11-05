import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
const openNewBot = async (page: Page) => {
  await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "新建 Bot", exact: true }).click();
};

// A-10: a failed engine catalog read explains the actual cause, and recovers
// in place; only a missing endpoint asks the owner to update the Hub.
test("new Bot catalog failures name their cause and recover without reopening", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "new-bot-catalog-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await pair(page, hub);
    // This Hub runs without a Bot manager, so "pass" serves a minimal catalog
    // and "host" forwards to its real bot_creation_unavailable reply.
    let mode: "error" | "missing" | "host" | "pass" = "error";
    const catalog = { engines: [{ id: "codex", available: true, models: [{ id: "default", efforts: [] }], defaultModel: "default", defaultEffort: "" }] };
    await page.route("**/api/bots/catalog", route => mode === "host" ? route.continue()
      : route.fulfill(mode === "pass" ? { status: 200, json: catalog } : mode === "missing" ? { status: 404, json: { error: "not_found" } } : { status: 503, json: { error: "unavailable" } }));
    await openNewBot(page);
    const alert = page.getByRole("alert").filter({ hasText: "暂时无法读取可用引擎，请重试。" });
    await expect(alert).toBeVisible();
    // A failed read must explain the empty form without a scroll to its footer.
    await expect(alert).toBeInViewport();
    await expect(alert.getByRole("button", { name: "重新读取", exact: true })).toBeInViewport();
    await expect(page.getByText("此 Hub 暂未启用 Bot 创建，请更新 Hub 后重试。", { exact: true })).toHaveCount(0);
    mode = "pass";
    await alert.getByRole("button", { name: "重新读取", exact: true }).click();
    // Every catalog failure message is gone and the served engine is offered.
    await expect(page.getByRole("alert").filter({ hasText: /引擎|Bot 创建|连接中断/ })).toHaveCount(0);
    await expect(page.getByLabel("引擎", { exact: true })).toHaveValue("codex");
    await expect(page.getByRole("status").filter({ hasText: "正在读取可用引擎…" })).toHaveCount(0);
    // A Hub without the endpoint still gets the upgrade explanation, without a retry loop.
    await page.getByRole("button", { name: "关闭新建对话", exact: true }).click();
    mode = "missing"; await openNewBot(page);
    const missing = page.getByRole("alert").filter({ hasText: "此 Hub 暂未启用 Bot 创建，请更新 Hub 后重试。" });
    await expect(missing).toBeVisible();
    await expect(missing.getByRole("button", { name: "重新读取", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭新建对话", exact: true }).click();
    mode = "host"; await openNewBot(page);
    await expect(missing).toBeVisible();
    await expect(missing.getByRole("button", { name: "重新读取", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭新建对话", exact: true }).click();
    mode = "pass"; catalog.engines[0]!.available = false; await openNewBot(page);
    await expect(page.getByRole("alert").filter({ hasText: "此主机尚未检测到支持的 AI CLI。" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "创建 Bot", exact: true })).toBeDisabled();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
