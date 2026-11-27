import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { HOST_BALANCE_RESOURCES_PATH } from "../../src/client-protocol/host-balance-resources.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

async function named(hub: HubServer, name: string) {
  await hub.store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [
    HOST_PROFILE_KEY,
    JSON.stringify({ name, revision: 1 }),
  ]);
}

async function seedBot(hub: HubServer, id: string, name: string, engine = "claude", model = "", role = "") {
  await hub.store.db.run(
    "INSERT INTO bots(id,name,secret_hash,engine,model,effort,online,role) VALUES(?,?,'fixture',?,?,'',1,?)",
    [id, name, engine, model, role],
  );
}

async function pairHost(page: Page, hub: HubServer, hostName: string) {
  await page.getByLabel("主机名称", { exact: true }).fill(hostName);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  const code = page.getByLabel("配对码", { exact: true });
  await expect(code).toBeVisible();
  const value = await code.innerText();
  await hub.auth.approve(value, "local-owner");
  await expect(code).toHaveCount(0, { timeout: 15_000 });
  await waitForClientOnline(page);
}

async function openNewDirectDialog(page: Page) {
  await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
  await page.locator(".create-menu").getByRole("button", { name: "新建对话" }).click();
}

function makeResources(overrides: { cpuPercent: number; memoryUsedPercent: number; activeTurns?: number; activeTickets?: number }) {
  const memoryTotalBytes = 16 * 1024 ** 3;
  const memoryFreeBytes = Math.round(memoryTotalBytes * ((100 - overrides.memoryUsedPercent) / 100));
  return {
    cpuPercent: overrides.cpuPercent,
    cpuCores: 8,
    loadAvg1m: Math.round((overrides.cpuPercent / 100) * 8 * 100) / 100,
    memoryUsedPercent: overrides.memoryUsedPercent,
    memoryFreeBytes,
    memoryTotalBytes,
    activeTurns: overrides.activeTurns ?? 0,
    activeTickets: overrides.activeTickets ?? 0,
    capturedAt: Date.now(),
  };
}

test("multi-host load balancing settings, 3-host selection, quota/telemetry exclusion, filter reset, and idempotent bot retry", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lb-e2e-"));
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const aUrl = a.url;
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [aUrl] });
  const c = await HubServer.start({ stateDir: path.join(root, "c"), origins: [aUrl] });
  const bUrl = b.url;
  const cUrl = c.url;

  try {
    await named(a, "主机甲");
    await named(b, "主机乙");
    await named(c, "主机丙");
    await seedBot(a, "bot_a_claude", "甲 Claude", "claude");
    await seedBot(b, "bot_b_claude", "乙 Claude", "claude");
    await seedBot(c, "bot_c_claude", "丙 Claude", "claude");

    // Default telemetry: A is busy, B is idle, C is idle
    let telemetryMode: "normal" | "all_fail" | "quota_block_bc" | "create_bot_retry" | "filter_reset" = "normal";
    await page.route(`**${HOST_BALANCE_RESOURCES_PATH}`, async (route) => {
      if (telemetryMode === "all_fail") {
        await route.fulfill({ status: 500, json: { error: "telemetry_failed" } });
        return;
      }
      const url = route.request().url();
      if (url.startsWith(aUrl)) {
        await route.fulfill({ json: makeResources({ cpuPercent: 84, memoryUsedPercent: 82, activeTurns: 3, activeTickets: 1 }) });
      } else if (url.startsWith(bUrl)) {
        if (telemetryMode === "filter_reset") {
          await route.fulfill({ json: makeResources({ cpuPercent: 88, memoryUsedPercent: 84, activeTurns: 3, activeTickets: 1 }) });
        } else {
          await route.fulfill({ json: makeResources({ cpuPercent: 18, memoryUsedPercent: 36, activeTurns: 0 }) });
        }
      } else {
        await route.fulfill({ json: makeResources({ cpuPercent: 20, memoryUsedPercent: 38, activeTurns: 0 }) });
      }
    });

    await page.route(url => url.pathname === "/api/engine-quotas", async (route) => {
      const url = route.request().url();
      const now = new Date().toISOString();
      if (telemetryMode === "quota_block_bc" && url.startsWith(bUrl)) {
        await route.fulfill({
          json: {
            generatedAt: now,
            scopes: [{
              id: "bot_b_claude", revision: "r_b", engine: "claude", label: "乙 Claude", botIds: ["bot_b_claude"], sharing: "unverified",
              authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "blocked", observedAt: now,
              pools: [], constraints: [{ code: "ordinary_usage_blocked", availability: "blocked" }],
            }],
          },
        });
        return;
      }
      if (telemetryMode === "quota_block_bc" && url.startsWith(cUrl)) {
        await route.fulfill({
          json: {
            generatedAt: now,
            scopes: [{
              id: "bot_c_claude", revision: "r_c", engine: "claude", label: "丙 Claude", botIds: ["bot_c_claude"], sharing: "unverified",
              authMode: "subscription", capability: { mode: "active" }, state: "login_required", reason: "login_required", availability: "unknown",
              pools: [], constraints: [],
            }],
          },
        });
        return;
      }
      await route.fulfill({ json: { generatedAt: now, scopes: [] } });
    });

    // Pair all 3 Hosts
    await page.goto(aUrl);
    await pairHost(page, a, "主机甲");
    await clickAppAction(page, "连接另一台主机");
    await pairHost(page, b, "主机乙");
    await clickAppAction(page, "连接另一台主机");
    await pairHost(page, c, "主机丙");

    // 1. Open Settings → Network & connections, verify Load balancing section and set preferences
    await clickAppAction(page, "设置");
    const settingsDialog = page.getByRole("dialog", { name: "设置" });
    await settingsDialog.locator('button[data-section="network"]').click();
    const lbSection = settingsDialog.getByRole("region", { name: "负载均衡" });
    await expect(lbSection).toBeVisible();
    await expect(lbSection).toContainText("CPU 84%");
    await expect(lbSection).toContainText("CPU 18%");
    await expect(lbSection).toContainText("CPU 20%");

    // Enable auto-select by default, set Host B to "less_often" so idle Host C wins
    await lbSection.getByRole("switch", { name: "新建对话时默认自动选择主机" }).click();
    await lbSection.getByLabel("主机乙 的负载均衡偏好").selectOption("less_often");
    await page.keyboard.press("Escape");

    // 2. Open New Conversation dialog -> verify auto-select picks Host C (A busy, B less_often, C idle)
    await openNewDirectDialog(page);
    const dialog = page.getByRole("dialog", { name: "新建对话" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".lb-result-host")).toContainText("主机丙");
    await expect(dialog.locator(".lb-bot-plan")).toContainText("丙 Claude");
    await dialog.getByLabel("对话名称（可选）").fill("负载均衡自动对话");
    await dialog.getByRole("button", { name: "在选定主机创建对话" }).click();
    await expect(dialog).toHaveCount(0);

    // Verify conversation actually landed on Hub C
    const cConvs = await c.store.conversations("owner");
    expect(cConvs.some((conv) => conv.title === "负载均衡自动对话")).toBe(true);

    // 3. Quota exhaustion (B) & login_required (C) exclude B and C, routing to A
    telemetryMode = "quota_block_bc";
    await openNewDirectDialog(page);
    await expect(dialog.locator(".lb-result-host")).toContainText("主机甲");
    await page.keyboard.press("Escape");

    // 4. All telemetry failing -> falls back to manual with resources_unavailable
    telemetryMode = "all_fail";
    await openNewDirectDialog(page);
    await expect(dialog).toContainText("暂无可自动分配的主机，请改为手动选择");
    await expect(dialog).toContainText("无法读取主机负载");
    await page.keyboard.press("Escape");

    // 5. Idempotent Bot creation on retry (no duplicate orphan Bot when POST /api/conversations fails once)
    telemetryMode = "create_bot_retry";
    let piCatalogSawIncludePi = false;
    let botPostCount = 0;
    let convFailOnce = true;
    await page.route("**/api/bots/catalog*", async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.includes("includePi=1")) piCatalogSawIncludePi = true;
      const isHostC = reqUrl.startsWith(cUrl);
      await route.fulfill({
        json: {
          engines: [{
            id: "pi",
            available: isHostC,
            catalogStatus: "ready",
            defaultModel: "openai/gpt-5",
            defaultEffort: "high",
            permissions: { defaultChoice: "bypass", choices: [] },
            models: [{ id: "openai/gpt-5", efforts: ["", "high"] }],
          }],
        },
      });
    });
    await page.route(`${cUrl}/api/bots`, async (route) => {
      if (route.request().method() === "POST") {
        botPostCount++;
        await seedBot(c, "bot_c_pi_auto", "Pi", "pi", "openai/gpt-5");
        await route.fulfill({
          status: 201,
          json: { id: "bot_c_pi_auto", name: "Pi", engine: "pi", model: "openai/gpt-5", effort: "high", online: 1 },
        });
        return;
      }
      await route.continue();
    });
    await page.route(`${cUrl}/api/conversations`, async (route) => {
      if (route.request().method() === "POST" && convFailOnce) {
        convFailOnce = false;
        await route.fulfill({ status: 500, json: { error: "temporary_failure" } });
        return;
      }
      await route.continue();
    });

    await openNewDirectDialog(page);
    await dialog.getByLabel("选择引擎").selectOption("pi");
    await expect(dialog.locator(".lb-result-host")).toContainText("主机丙");
    await dialog.getByLabel("对话名称（可选）").fill("重试幂等对话");
    await dialog.getByRole("button", { name: "在选定主机创建对话" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    // Retry: must NOT call POST /api/bots a second time
    await dialog.getByRole("button", { name: "在选定主机创建对话" }).click();
    await expect(dialog).toHaveCount(0);
    expect(piCatalogSawIncludePi).toBe(true);
    expect(botPostCount).toBe(1);
    expect((await c.store.conversations("owner")).some((conv) => conv.title === "重试幂等对话")).toBe(true);

    // 6. Verify sidebar host filter clears when AutoHostDialog creates a conversation on a different Host
    telemetryMode = "filter_reset";
    const hostFilter = page.locator(".host-workspace:not([hidden])").getByLabel("筛选运行主机");
    await hostFilter.selectOption({ label: "主机甲" });
    await a.close();
    await expect(page.locator(".host-workspace:not([hidden]) .offline-banner")).toBeVisible({ timeout: 10_000 });
    await openNewDirectDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".lb-result-host")).toContainText("主机丙");
    await dialog.getByLabel("对话名称（可选）").fill("过滤恢复对话");
    await dialog.getByRole("button", { name: "在选定主机创建对话" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".host-workspace:not([hidden])").getByLabel("筛选运行主机")).toHaveValue("");
    expect((await c.store.conversations("owner")).some((conv) => conv.title === "过滤恢复对话")).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await Promise.all([a.close().catch(() => undefined), b.close().catch(() => undefined), c.close().catch(() => undefined)]);
    await rm(root, { recursive: true, force: true });
  }
});
