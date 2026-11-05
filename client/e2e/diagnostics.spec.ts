import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openWorkspacePage, selectConversation } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings } from "./fixtures/settings.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
test("desktop and phone inspect real Bot timelines and Hub audit, filter, page and refresh without exposing secrets", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-diagnostics-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const records = Array.from({ length: 65 }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString(), type: i % 3 ? "turn.completed" : "turn.retried", outcome: i % 3 ? "success" : "error", channel: "lark", chatId: 42, conversationKey: "lark:gw_shared", detail: `测试任务 ${i} token=fixture-only-secret`, metadata: { task: i, api_key: "fixture-only-key" } }));
  const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");
  await writeFile(path.join(stateDir, "timeline.log.jsonl.1"), lines(records.slice(0, 35))); await writeFile(path.join(stateDir, "timeline.log.jsonl"), lines(records.slice(35)));
  await writeFile(path.join(stateDir, "audit.log.jsonl"), lines([{ ...records[0], type: "command.handled", detail: "审计对齐记录" }]));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','验收助手',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir, botId: "alpha", secret, url: hub.url.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(), errors: string[] = [];
  for (const page of [desktop, phone]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    for (const page of [desktop, phone]) {
      await pair(page, hub);
      await openWorkspacePage(page, "运行状态"); await page.getByRole("button", { name: "运行记录", exact: true }).click();
      await expect(page.locator(".diagnostic-event")).toHaveCount(30); await expect(page.locator(".diagnostic-count")).toContainText("有效记录 65 条"); await expect(page.locator(".diagnostic-metrics")).toContainText("22");
      await expect(page.locator(".diagnostics-panel")).not.toContainText("fixture-only-secret"); await expect(page.locator(".diagnostics-panel")).not.toContainText("fixture-only-key");
    }
    await desktop.getByRole("button", { name: "加载更早记录", exact: true }).click(); await expect(desktop.locator(".diagnostic-event")).toHaveCount(60);
    await desktop.getByRole("button", { name: "加载更早记录", exact: true }).click(); await expect(desktop.locator(".diagnostic-event")).toHaveCount(65); await expect(desktop.getByRole("button", { name: "加载更早记录", exact: true })).toHaveCount(0);
    await desktop.getByLabel("会话标识", { exact: true }).fill("42");
    await desktop.getByLabel("执行结果", { exact: true }).selectOption("error"); await desktop.getByLabel("消息通道", { exact: true }).selectOption("gateway"); await desktop.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(desktop.locator(".diagnostic-event")).toHaveCount(22);
    await desktop.getByLabel("关键词", { exact: true }).fill("测试任务 3"); await desktop.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(desktop.locator(".diagnostic-event")).toHaveCount(5);
    await desktop.locator(".diagnostic-event").first().getByText("查看记录详情", { exact: true }).click(); await expect(desktop.locator(".diagnostic-event").first().locator("pre")).toContainText("[redacted]");
    await desktop.locator(".operations-panel").evaluate((e) => { e.scrollTop = 0; }); await desktop.screenshot({ path: info.outputPath("diagnostics-desktop-light.png") });
    await phone.getByLabel("记录来源", { exact: true }).selectOption("audit"); await phone.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(phone.locator(".diagnostic-event")).toHaveCount(1); await expect(phone.locator(".diagnostic-event")).toContainText("审计对齐记录");
    await phone.locator(".operations-panel").evaluate((e) => { e.scrollTop = 0; }); await phone.screenshot({ path: info.outputPath("diagnostics-phone.png") });
    await appendFile(path.join(stateDir, "audit.log.jsonl"), lines([{ ...records[1], type: "command.handled", detail: "双端新记录" }]));
    await phone.getByRole("button", { name: "刷新记录", exact: true }).click(); await expect(phone.locator(".diagnostic-event")).toHaveCount(2); await expect(phone.locator(".diagnostic-event").first()).toContainText("双端新记录");
    await desktop.getByLabel("记录来源", { exact: true }).selectOption("audit"); await desktop.getByLabel("关键词", { exact: true }).fill(""); await desktop.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(desktop.locator(".diagnostic-event")).toHaveCount(2);
    await phone.getByRole("button", { name: "返回运行概览", exact: true }).click(); await phone.getByRole("button", { name: "查看 Hub 审计", exact: true }).click(); await expect(phone.locator(".diagnostic-event").filter({ hasText: "pairing.approved" })).toHaveCount(2);
    await phone.getByText("更多筛选", { exact: true }).click(); await phone.getByLabel("事件类型", { exact: true }).fill("pairing.approved"); await phone.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(phone.locator(".diagnostic-event")).toHaveCount(2);
    await phone.getByLabel("开始时间", { exact: true }).fill("2026-10-23T10:01");
    await phone.getByLabel("结束时间", { exact: true }).fill("2026-10-23T18:35");
    const from = (await phone.getByLabel("开始时间", { exact: true }).boundingBox())!;
    const to = (await phone.getByLabel("结束时间", { exact: true }).boundingBox())!;
    expect(to.y).toBeGreaterThanOrEqual(from.y + from.height);
    expect(from.width).toBeGreaterThan(300);
    const dateLabel = (await phone.getByLabel("开始时间", { exact: true }).locator("..").boundingBox())!;
    expect(from.x + from.width).toBeLessThanOrEqual(dateLabel.x + dateLabel.width + 1);
    // Primary file-action buttons must not inherit the white secondary fill
    // while keeping white primary text (invisible on the physical iPhone).
    await expect.poll(() => phone.getByRole("button", { name: "应用筛选", exact: true }).evaluate(button => {
      const style = getComputedStyle(button), probe = document.createElement('span');
      button.append(probe);
      probe.style.color = 'var(--primary-bg)'; const normal = getComputedStyle(probe).color;
      probe.style.color = 'var(--primary-hover)'; const hover = getComputedStyle(probe).color;
      const colors = { background: style.backgroundColor, text: style.color, normal, hover };
      probe.remove(); return [colors.normal, colors.hover].includes(colors.background) && colors.text !== colors.background;
    })).toBe(true);
    for (const p of [desktop, phone]) expect(await p.locator(".operations-panel").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await desktop.getByRole("button", { name: "关闭运行状态", exact: true }).click(); await openSettings(desktop, "general"); await desktop.getByLabel("主题", { exact: true }).selectOption("dark"); await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await clickAppAction(desktop, "运行状态", desktop.getByRole("button", { name: "运行状态", exact: true })); await desktop.getByRole("button", { name: "运行记录", exact: true }).click(); await expect(desktop.locator(".diagnostic-event")).toHaveCount(30); await desktop.screenshot({ path: info.outputPath("diagnostics-desktop-dark.png") });
    await desktop.getByRole("button", { name: "关闭运行状态", exact: true }).click(); await openSettings(desktop, "general"); await desktop.getByLabel("语言", { exact: true }).selectOption("en"); await desktop.getByRole("button", { name: "Close settings", exact: true }).click(); await clickAppAction(desktop, "Operations", desktop.getByRole("button", { name: "Operations", exact: true })); await desktop.getByRole("button", { name: "Activity records", exact: true }).click(); await expect(desktop.getByRole("button", { name: "Apply filters", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await desktopContext.close(); await phoneContext.close(); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
