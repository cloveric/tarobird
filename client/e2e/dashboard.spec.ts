import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openSettings } from "./fixtures/settings.js";
import { mobileHome, openMobileHome, openWorkspacePage, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { CronStore } from "../../src/state/cron-store.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
test("desktop and phone share activity, cron, crew and UTC usage with truthful unknown/offline states", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-dashboard-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const at = "2026-09-30T00:00:00.000Z", save = (file: string, data: unknown) => writeFile(path.join(stateDir, file), JSON.stringify(data));
  await save("config.json", { engine: "claude", model: "sonnet", effort: "high", locale: "zh", timezone: "Asia/Shanghai" });
  const bucket = { totalInputTokens: 1200, totalOutputTokens: 300, totalCachedTokens: 400, totalCostUsd: 0.125, requestCount: 2, unmeteredRequestCount: 1, lastUpdatedAt: at };
  const usage = { ...bucket, daily: { "2026-09-30": bucket, "2026-09-28": { ...bucket, totalCostUsd: 0 } }, monthly: { "2026-09": bucket } };
  await save("usage.json", usage); await save("runtime-state.json", { activeTurnCount: 99, activeTurnStartedAt: at });
  const runtime = createCoreServiceRuntime(); runtime.activeRuns.set("lark:gw_shared", { abortController: new AbortController(), startedAt: Date.parse(at) });
  const cron = new CronStore(stateDir, { defaultTimezone: "Asia/Shanghai" });
  const job = await cron.add({ chatId: 42, userId: 1, channel: "lark", conversationKey: "lark:gw_shared", cronExpr: "0 9 * * *", prompt: "每天整理项目进展", sessionMode: "reuse" });
  await cron.recordRun(job.id, { ranAt: at, success: false, error: "网络中断 token=fixture-secret" });
  await cron.add({ chatId: 42, userId: 1, cronExpr: "0 9 * * *", prompt: "下午会议提醒", runOnce: true, targetAt: "2030-10-02T06:00:00.000Z" });
  await cron.add({ chatId: 42, userId: 1, cronExpr: "0 10 * * *", prompt: "已暂停周报", enabled: false });
  await mkdir(path.join(stateDir, "crew-runs")); await save("crew-runs/research.json", { runId: "fixture-crew", workflow: "research-report", status: "running", currentStage: "review", coordinator: "研究助手", chatId: 42, userId: 1, locale: "zh", originalPrompt: "研究客户端跨设备体验", createdAt: at, updatedAt: at, stages: { decomposition: { status: "completed", updatedAt: at }, research: { status: "completed", updatedAt: at }, review: { status: "running", updatedAt: at, detail: "待核对引用来源", verdict: "revise", revisionCount: 1 } } });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','验收助手',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir, botId: "alpha", secret, engine: "claude", url: hub.url.replace("http", "ws") + "/instance", runtime, bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(), errors: string[] = [];
  for (const page of [desktop, phone]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    for (const page of [desktop, phone]) {
      await pair(page, hub); await openWorkspacePage(page, "运行状态");
      // An unmanaged Bot has no collaboration button and no stray "0" beside its actions.
      await expect(page.getByRole("button", { name: "详细概览", exact: true })).toBeVisible();
      expect(await page.locator(".operation-bot .quick-actions").first().evaluate(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE))).toBe(false);
      await page.getByRole("button", { name: "详细概览", exact: true }).click();
      await expect(page.locator(".dashboard-metrics>div").filter({ hasText: "正在执行" })).toHaveText("正在执行1");
      await expect(page.locator(".bot-dashboard")).toContainText("lark:gw_shared");
      await page.getByRole("navigation", { name: "概览分类" }).getByRole("button", { name: "定时任务", exact: true }).click(); await expect(page.locator(".dashboard-cron")).toHaveCount(3);
      const daily = page.locator(".dashboard-cron").filter({ hasText: "每天整理项目进展" });
      await daily.getByText("任务设置与执行历史", { exact: true }).click(); await expect(daily).toContainText("Asia/Shanghai"); await expect(daily).toContainText("复用会话"); await expect(daily).not.toContainText("fixture-secret");
      await expect(daily.locator(".dashboard-history li")).toHaveCount(1);
      await page.getByRole("button", { name: "协作流程", exact: true }).click(); await expect(page.locator(".dashboard-stages li")).toHaveCount(3); await expect(page.locator(".bot-dashboard")).toContainText("不代表此刻仍有任务运行");
      await page.getByRole("button", { name: "日/月用量", exact: true }).click();
      await page.getByLabel("统计期间（UTC）", { exact: true }).selectOption("2026-09-30"); await expect(page.locator(".dashboard-metrics")).toContainText("$0.1250"); await expect(page.locator(".dashboard-metrics")).toContainText("1,200");
      await page.getByLabel("统计期间（UTC）", { exact: true }).selectOption("2026-09-28"); await expect(page.locator(".dashboard-metrics")).toContainText("费用未知");
      await page.getByLabel("统计周期", { exact: true }).selectOption("monthly"); await page.getByLabel("统计期间（UTC）", { exact: true }).selectOption("2026-09"); await expect(page.locator(".dashboard-metrics")).toContainText("$0.1250");
      expect(await page.locator(".operations-panel").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    }
    await desktop.locator(".operations-panel").evaluate((e) => { e.scrollTop = 0; }); await desktop.screenshot({ path: info.outputPath("dashboard-desktop-light.png") });
    await phone.locator(".operations-panel").evaluate((e) => { e.scrollTop = 0; }); await phone.screenshot({ path: info.outputPath("dashboard-phone.png") });
    runtime.activeRuns.clear();
    await cron.recordRun(job.id, { ranAt: "2026-10-02T01:00:00.000Z", success: true });
    await save("usage.last-good.json", { ...usage, totalInputTokens: 1400 }); await writeFile(path.join(stateDir, "usage.json"), "{broken");
    for (const page of [desktop, phone]) {
      await page.getByRole("button", { name: "刷新概览", exact: true }).click(); await expect(page.locator(".bot-dashboard")).toContainText("数据可能较旧");
      await page.getByLabel("统计周期", { exact: true }).selectOption("total"); await expect(page.locator(".dashboard-metrics")).toContainText("1,400");
      await page.getByRole("button", { name: "当前活动", exact: true }).click(); await expect(page.locator(".bot-dashboard")).toContainText("采样时没有正在执行的会话");
      await page.getByRole("navigation", { name: "概览分类" }).getByRole("button", { name: "定时任务", exact: true }).click(); const daily = page.locator(".dashboard-cron").filter({ hasText: "每天整理项目进展" }); await daily.getByText("任务设置与执行历史", { exact: true }).click(); await expect(daily.locator(".dashboard-history li")).toHaveCount(2); await expect(daily.locator(".dashboard-history li").first()).toContainText("成功");
    }
    expect(await readFile(path.join(stateDir, "usage.json"), "utf8")).toBe("{broken");
    await desktop.getByRole("button", { name: "关闭运行状态", exact: true }).click(); await openSettings(desktop, "general"); await desktop.getByLabel("主题", { exact: true }).selectOption("dark"); await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await clickAppAction(desktop, "运行状态", desktop.getByRole("button", { name: "运行状态", exact: true })); await expect(desktop.locator(".operation-bot")).toContainText("数据可能较旧"); await desktop.getByRole("button", { name: "详细概览", exact: true }).click(); await desktop.getByRole("button", { name: "协作流程", exact: true }).click(); await expect(desktop.locator(".dashboard-stages li")).toHaveCount(3); await desktop.screenshot({ path: info.outputPath("dashboard-desktop-dark.png") });
    expect(await readFile(path.join(stateDir, "usage.json"), "utf8")).toBe("{broken");
    await desktop.getByRole("button", { name: "查看任务时间线", exact: true }).click(); await expect(desktop.getByRole("button", { name: "应用筛选", exact: true })).toBeVisible();
    await desktop.getByRole("button", { name: "关闭运行状态", exact: true }).click(); await openSettings(desktop, "general"); await desktop.getByLabel("语言", { exact: true }).selectOption("en"); await desktop.getByRole("button", { name: "Close settings", exact: true }).click(); await clickAppAction(desktop, "Operations", desktop.getByRole("button", { name: "Operations", exact: true })); await desktop.getByRole("button", { name: "Bot dashboard", exact: true }).click(); await expect(desktop.getByRole("button", { name: "Refresh dashboard", exact: true })).toBeVisible();
    await channel.disconnect(); await phone.getByRole("button", { name: "刷新概览", exact: true }).click(); await expect(phone.locator(".bot-dashboard")).toContainText("实时状态无法确认"); await expect(phone.locator(".bot-dashboard [role=alert]")).toContainText("Bot 当前离线");
    await phone.getByRole("button", { name: "当前活动", exact: true }).click(); await expect(phone.locator(".dashboard-metrics")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await desktopContext.close(); await phoneContext.close(); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("large task lists stay searchable and paged on both devices while phone stop remains responsive", async ({ browser }, info) => {
  const { dashboardScaleJobs } = await import("../../tests/fixtures/dashboard-scale.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "client-dashboard-scale-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const jobs = dashboardScaleJobs();
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const save = (rows: typeof jobs) => writeFile(path.join(stateDir, "cron-jobs.json"), JSON.stringify({ jobs: rows })); await save(jobs);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('scale','性能验收助手',?)", [hashSecret(secret)]);
  await hub.store.createConversation("owner", ["scale"], "性能验收对话", "scale-chat");
  let abortedAt = 0; const calls: string[] = [], runtime = createCoreServiceRuntime();
  const channel = await attachGateway({ stateDir, botId: "scale", secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime,
    bridge: { handleAuthorizedMessage: async (input) => {
      calls.push(input.text);
      if (!input.text.includes("等待停止")) return { text: "概览读取后聊天正常" };
      await input.onEngineEvent?.({ type: "assistant_text", text: "任务仍在执行", delta: true });
      await new Promise<void>((resolve) => {
        const abort = () => { abortedAt = performance.now(); resolve(); };
        if (input.abortSignal?.aborted) abort(); else input.abortSignal?.addEventListener("abort", abort, { once: true });
      });
      throw new Error("Stopped by user");
    } } });
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1360, height: 900 } }),
    browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
  ]);
  const [desktop, phone] = await Promise.all(contexts.map((context) => context.newPage()));
  const errors: string[] = [], timings: unknown[] = [];
  for (const page of [desktop!, phone!]) page.on("pageerror", (error) => errors.push(error.message));
  try {
    for (const page of [desktop!, phone!]) { await pair(page, hub); await selectConversation(page, "性能验收对话"); }
    await desktop!.getByRole("textbox", { name: "消息", exact: true }).fill("等待停止");
    await desktop!.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(phone!.getByText("任务仍在执行", { exact: true })).toBeVisible();
    for (const [page, device] of [[desktop!, "desktop"], [phone!, "phone"]] as const) {
      // The phone leaves the running chat through its back control; the dashboard lives on Me.
      if (device === "phone") await openMobileHome(page);
      await openWorkspacePage(page, "运行状态");
      await page.getByRole("button", { name: "详细概览", exact: true }).click();
      await expect(page.getByRole("button", { name: "刷新概览", exact: true })).toBeEnabled();
      await expect(page.locator(".dashboard-metrics")).toBeVisible();
      const start = performance.now();
      await page.getByRole("navigation", { name: "概览分类" }).getByRole("button", { name: "定时任务", exact: true }).click();
      await expect(page.locator(".dashboard-cron")).toHaveCount(25);
      const renderMs = performance.now() - start; expect(renderMs).toBeLessThan(1500);
      timings.push({ device, renderMs });
      await expect(page.locator(".dashboard-history li")).toHaveCount(0);
      const first = page.locator(".dashboard-cron").first();
      await first.getByText("任务设置与执行历史", { exact: true }).click(); await expect(first.locator(".dashboard-history li")).toHaveCount(10);
      await first.getByText("任务设置与执行历史", { exact: true }).click(); await expect(first.locator(".dashboard-history li")).toHaveCount(0);
      await page.getByLabel("搜索定时任务", { exact: true }).fill("00001387");
      await expect(page.locator(".dashboard-cron")).toHaveCount(1); await expect(page.locator(".dashboard-cron")).toContainText("定时任务 04999");
      await page.getByLabel("任务状态", { exact: true }).selectOption("enabled"); await expect(page.getByText("没有匹配的任务，试试调整筛选条件。", { exact: true })).toBeVisible();
      await page.getByLabel("搜索定时任务", { exact: true }).fill(""); await page.getByLabel("任务状态", { exact: true }).selectOption("all");
      await page.getByLabel("任务页码", { exact: true }).selectOption("199");
      await expect(page.locator(".dashboard-cron")).toHaveCount(25); await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
      expect(await page.locator(".operations-panel").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`dashboard-scale-${device}.png`) });
    }
    // Both use the real authenticated Hub/Gateway transport; no paid engine call.
    await phone!.locator(".settings-page-back").click(); await phone!.locator(".settings-page-back").click();
    await mobileHome(phone!).getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: /^消息/ }).click();
    await selectConversation(phone!, "性能验收对话");
    let maxGap = 0, tick = performance.now();
    const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - tick); tick = now; }, 5);
    const start = performance.now();
    try {
      await Promise.all([
        desktop!.getByRole("button", { name: "刷新概览", exact: true }).click(),
        phone!.getByRole("button", { name: "停止当前轮次", exact: true }).click(),
      ]);
      await expect.poll(() => abortedAt, { timeout: 1000, intervals: [10, 20, 50] }).toBeGreaterThan(0);
      await expect(desktop!.getByRole("button", { name: "刷新概览", exact: true })).toBeEnabled();
    } finally { clearInterval(heartbeat); }
    expect(abortedAt - start).toBeLessThan(1000); expect(maxGap).toBeLessThan(500);
    timings.push({ stopMs: abortedAt - start, maxGatewayLoopGapMs: maxGap, rows: jobs.length });
    await phone!.getByRole("textbox", { name: "消息", exact: true }).fill("继续聊天"); await phone!.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(phone!.getByText("概览读取后聊天正常", { exact: true })).toBeVisible();
    await save(jobs.slice(0, 27));
    await desktop!.getByRole("button", { name: "刷新概览", exact: true }).click();
    await expect(desktop!.getByLabel("任务页码", { exact: true })).toHaveValue("1"); await expect(desktop!.locator(".dashboard-cron")).toHaveCount(2);
    await desktop!.getByRole("button", { name: "上一页", exact: true }).click(); await expect(desktop!.locator(".dashboard-cron")).toHaveCount(25);
    await desktop!.getByRole("button", { name: "关闭运行状态", exact: true }).click();
    // The desktop sidebar row previews the same reply; assert the chat itself.
    await expect(desktop!.getByRole("main").getByText("概览读取后聊天正常", { exact: true })).toBeVisible();
    expect(calls).toHaveLength(2); expect(errors).toEqual([]);
    await info.attach("dashboard-scale-latency", { body: JSON.stringify(timings), contentType: "application/json" });
    console.log("Dashboard scale", JSON.stringify(timings));
  } finally {
    for (const run of runtime.activeRuns.values()) run.abortController?.abort();
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined))); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
