import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { unavailableQuota } from "../../src/codex/account-quota.js";
import type { QuotaSnapshot } from "../../src/client-protocol/engine-quota.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { createServer } from "./fixtures/vite.js";
import type { multipleHosts } from "./fixtures/multiple-hosts.js";

test.use({ serviceWorkers: "block" });
type QuotaLimit = { id: "primary" | "secondary"; used: number; period: number } & ({ resetHours: number } | { resetsAt: string });
type Readings = { context?: { used: number; window: number; compact?: number }; limits: QuotaLimit[] };
const plenty = (): Readings => ({ context: { used: 76_000, window: 200_000, compact: 168_000 }, limits: [{ id: "primary", used: 20, period: 18_000, resetHours: 2 }, { id: "secondary", used: 10, period: 604_800, resetHours: 120 }] });
const nearlyGone = (): Readings => ({ context: { used: 176_000, window: 200_000, compact: 168_000 }, limits: [{ id: "primary", used: 66, period: 18_000, resetHours: 2 }, { id: "secondary", used: 99, period: 604_800, resetHours: 120 }] });
function quota(limits: Readings["limits"]): QuotaSnapshot {
  const now = Date.now(), at = new Date(now).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
  return { authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown", observedAt: at, lastAttemptAt: at, constraints: [], help: "codex_usage",
    pools: [{ id: "codex", label: "Codex", sharing: "unspecified", availability: "unknown", balances: [], constraints: [], windows: limits.map(item => ({ id: item.id, label: item.id === "primary" ? "Primary" : "Secondary", metric: "percent" as const, usedPercent: item.used,
      availability: "unknown" as const, observedAt: at, expiresAt, periodSeconds: item.period,
      resetsAt: "resetsAt" in item ? item.resetsAt : new Date(now + item.resetHours * 3_600_000).toISOString() })) }] };
}
/** A Bot whose engine reports the given readings. Like a real engine it has no quota reading until it is asked once. */
async function bot(hub: HubServer, root: string, id: string, engine: "codex" | "claude", readings?: { value: Readings; quota: boolean; asked: boolean[]; forget?: () => void }) {
  const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, model: engine === "codex" ? "gpt-6.1-sol" : "opus", effort: "high", locale: "zh" }));
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
  let loaded = false;
  // As after a restart of the Bot's worker: the Host holds no reading until the engine is asked again.
  if (readings) readings.forget = () => { loaded = false; };
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: async () => ({ text: "好的" }),
    ...(readings ? { getContextUsage: async () => readings.value.context ? { pressureTokens: readings.value.context.used, contextWindow: readings.value.context.window, autoCompactTokens: readings.value.context.compact } : null } : {}),
    ...(readings?.quota ? { readAccountQuota: async (options: { refresh: boolean }) => { readings.asked.push(options.refresh); if (options.refresh) loaded = true; return { revision: "revision_one", snapshot: loaded ? quota(readings.value.limits) : unavailableQuota("codex", "not_loaded") }; } } : {}) };
  return attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, model: engine === "codex" ? "gpt-6.1-sol" : "opus", effort: "high", runtime: createCoreServiceRuntime(), bridge });
}
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
function requests(page: Page) {
  const seen: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); if (/\/context-usage$|\/api\/engine-quotas\//.test(url.pathname)) seen.push(url.pathname + url.search); });
  return seen;
}
async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-indicators-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
  const readings: { value: Readings; quota: boolean; asked: boolean[]; forget?: () => void } = { value: plenty(), quota: true, asked: [] };
  const gateways = [await bot(hub, root, "alpha", "codex", readings), await bot(hub, root, "beta", "claude"), await bot(hub, root, "gamma", "codex", { value: plenty(), quota: false, asked: [] })];
  const both = await hub.store.createConversation("owner", ["alpha"], "有读数", "both");
  await hub.store.createConversation("owner", ["beta"], "读不到", "none");
  await hub.store.createConversation("owner", ["gamma"], "只有上下文", "context");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  return { hub, readings, both, dispose: async () => { await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test("desktop: ring and battery sit left of the model controls, each only when readable, with every window in the details", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const ws = workspace(page), indicators = ws.locator(".usage-indicators"), ring = indicators.locator("[data-usage=context]"), battery = indicators.locator("[data-usage=quota]");
    await selectConversation(page, "有读数");
    await expect(ring).toHaveText("62%"); await expect(battery).toHaveText("80%");
    await expect(ring).toHaveAttribute("data-tone", "ok"); await expect(battery).toHaveAttribute("data-tone", "ok");
    await expect(indicators).toHaveAccessibleName("上下文可用 62%，额度可用 80%");
    const layout = await ws.locator(".composer-toolbar").evaluate(toolbar => {
      const box = (selector: string) => toolbar.querySelector(selector)!.getBoundingClientRect(), usage = box(".usage-indicators"), model = box(".composer-model-controls"), send = box(".send-button");
      return { usageRight: usage.right, modelLeft: model.left, usageMiddle: usage.top + usage.height / 2, modelMiddle: model.top + model.height / 2, sendRight: send.right, toolbarRight: toolbar.getBoundingClientRect().right, overflow: toolbar.scrollWidth - toolbar.clientWidth };
    });
    expect(layout.usageRight).toBeLessThanOrEqual(layout.modelLeft + 1);
    expect(Math.abs(layout.usageMiddle - layout.modelMiddle)).toBeLessThan(3);
    expect(layout.sendRight).toBeLessThanOrEqual(layout.toolbarRight + 1); expect(layout.overflow).toBeLessThanOrEqual(1);
    await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-plenty.png"), animations: "disabled" });
    // The symbol's text is that of the model control beside it, not the toolbar's larger pill buttons.
    const type = await ws.locator(".composer-toolbar").evaluate(toolbar => { const style = (selector: string) => { const value = getComputedStyle(toolbar.querySelector(selector)!); return [value.fontSize, value.fontWeight, value.color].join(); }; return [style(".usage-indicators"), style(".composer-model-trigger")]; });
    expect(type[0]).toBe(type[1]);
    // Narrow desktop windows: nothing is pushed out of the composer and both numbers stay whole.
    for (const width of [900, 780, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      const narrow = await ws.locator(".composer-toolbar").evaluate(toolbar => { const usage = toolbar.querySelector(".usage-indicators")!, send = toolbar.querySelector(".send-button")!.getBoundingClientRect(), box = toolbar.getBoundingClientRect();
        return { overflow: toolbar.scrollWidth - toolbar.clientWidth, clipped: usage.scrollWidth - usage.clientWidth, sendRight: send.right, right: box.right, usageLeft: usage.getBoundingClientRect().left, left: box.left, page: document.documentElement.scrollWidth - innerWidth }; });
      expect(narrow.overflow, `${width}: ${JSON.stringify(narrow)}`).toBeLessThanOrEqual(1); expect(narrow.clipped).toBeLessThanOrEqual(0);
      expect(narrow.sendRight).toBeLessThanOrEqual(narrow.right + 1); expect(narrow.usageLeft).toBeGreaterThanOrEqual(narrow.left); expect(narrow.page).toBeLessThanOrEqual(0);
      if (width === 780) await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-780.png"), animations: "disabled" });
    }

    await indicators.click();
    const panel = page.getByRole("group", { name: "上下文与额度", exact: true });
    await expect(panel).toBeVisible(); await expect(indicators).toHaveAttribute("aria-expanded", "true");
    const context = panel.getByRole("region", { name: "上下文", exact: true }), limits = panel.getByRole("region", { name: "额度 · Codex", exact: true });
    await expect(context).toContainText("62%"); await expect(context).toContainText("已用 76k / 200k"); await expect(context).toContainText("用到约 84% 时自动压缩");
    await expect(limits.locator(".usage-window")).toHaveCount(2);
    // The window keeps its name (#77); the time left is a row of its own, counted from the reset stamp (5 days here, not the window's 7).
    await expect(limits.locator(".usage-window").nth(0)).toContainText("5 小时窗口"); await expect(limits.locator(".usage-window").nth(0)).toContainText("80%");
    await expect(limits.locator(".usage-window").nth(1)).toContainText("周额度（7 天）"); await expect(limits.locator(".usage-window").nth(1)).toContainText("90%");
    await expect(limits.locator(".usage-window").nth(0)).toContainText(/小时.*重置|分钟后重置/); await expect(limits.locator(".usage-window").nth(1)).toContainText(/\d+ 天(?:\s*\d+\s*小时)?后重置/);
    await expect(limits.locator(".usage-window").nth(1).locator(".usage-reset-row")).toContainText("5 天后重置");
    await expect(panel.getByRole("meter", { name: "上下文可用", exact: true })).toHaveAttribute("aria-valuenow", "62");
    await expect(panel).toContainText(/\d{2}:\d{2} 读取/);
    expect(`${await indicators.innerText()}${await panel.innerText()}`).not.toContain("剩");
    const placed = await panel.evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight }; });
    expect(placed.left).toBeGreaterThanOrEqual(0); expect(placed.right).toBeLessThanOrEqual(placed.width); expect(placed.top).toBeGreaterThanOrEqual(0);
    expect(placed.bottom).toBeLessThanOrEqual((await indicators.boundingBox())!.y);
    await page.screenshot({ path: info.outputPath("desktop-details.png"), animations: "disabled" });
    await page.keyboard.press("Escape"); await expect(panel).toBeHidden(); await expect(indicators).toBeFocused();

    // Neither reading: no symbol at all, the model controls stay.
    await selectConversation(page, "读不到");
    await expect(ws.locator(".composer-model-controls")).toBeVisible(); await expect(indicators).toHaveCount(0);
    // Only the context can be read: only the ring.
    await selectConversation(page, "只有上下文");
    await expect(ring).toHaveText("62%"); await expect(battery).toHaveCount(0);
    await expect(indicators).toHaveAccessibleName("上下文可用 62%");

    // Amber at a fifth left, red at a twentieth; the battery shows the tighter window.
    f.readings.value = nearlyGone();
    await selectConversation(page, "有读数");
    await expect(ring).toHaveText("12%"); await expect(battery).toHaveText("1%");
    await expect(ring).toHaveAttribute("data-tone", "low"); await expect(battery).toHaveAttribute("data-tone", "empty");
    await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-low.png"), animations: "disabled" });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const colours = await indicators.evaluate(node => ({ ring: getComputedStyle(node.querySelector(".usage-ring-left")!).stroke, battery: getComputedStyle(node.querySelector(".usage-battery-left")!).fill, text: getComputedStyle(node).color }));
      expect(new Set([colours.ring, colours.battery, colours.text]).size, JSON.stringify(colours)).toBe(3);
      if (theme === "dark") await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-low-dark.png"), animations: "disabled" });
    }

    // A reply ends: both are read again, without a timer.
    f.readings.value = { context: { used: 100_000, window: 200_000 }, limits: plenty().limits };
    await page.getByLabel("消息", { exact: true }).fill("你好"); await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(ws.locator(".message.bot").filter({ hasText: "好的" })).toHaveCount(1);
    await expect(ring).toHaveText("50%"); await expect(battery).toHaveText("80%");
    // The engine itself was asked once; every later number came from what the Host already held.
    expect(f.readings.asked.filter(Boolean)).toHaveLength(1);

    // The App restarts and the Host holds nothing any more: the reading saved on this device is shown once the
    // Bot's worker has answered that the login is the same, and the engine is not asked for it.
    f.readings.forget!();
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "有读数");
    await expect(battery).toHaveText("80%");
    expect(f.readings.asked.filter(Boolean)).toHaveLength(1);
    expect(Object.keys(JSON.parse(await page.evaluate(() => localStorage.getItem("tarobird.quotaReadings.v1") ?? "{}")))).toHaveLength(1);
  } finally { await f.dispose(); }
});

test("an open conversation takes one more reading shortly before the shown one ends", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fixture(page);
  try {
    const seen = requests(page), quotaReads = () => seen.filter(url => url.includes("/api/engine-quotas/alpha")).length;
    // Both windows reset in 35 s: that is when this reading stops counting.
    const soon = 35 / 3600;
    f.readings.value = { limits: [{ id: "primary", used: 20, period: 18_000, resetHours: soon }, { id: "secondary", used: 10, period: 604_800, resetHours: soon }] };
    await workspace(page).locator(".conversation-row").filter({ hasText: "有读数" }).filter({ visible: true }).click();
    const battery = page.locator(".usage-indicators [data-usage=quota]");
    await expect(battery).toBeVisible(); await expect(battery).toContainText("80%");
    const shownAt = Date.now(), before = quotaReads();
    // What the engine would answer next has later resets and another level.
    f.readings.value = { limits: [{ id: "primary", used: 45, period: 18_000, resetHours: 2 }, { id: "secondary", used: 30, period: 604_800, resetHours: 120 }] };
    // Nothing is opened and no reply ends. About 20 s before the end the App reads once more, and the battery
    // carries on with the newer figures past the moment the first reading ended.
    await expect.poll(quotaReads, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(Date.now() - shownAt).toBeGreaterThan(8_000);
    await expect(battery).toContainText("55%", { timeout: 10_000 });
    await page.waitForTimeout(Math.max(0, shownAt + 40_000 - Date.now()));
    await expect(battery).toBeVisible(); await expect(battery).toContainText("55%");
  } finally { await f.dispose(); }
});

test("quota is never requested for a user who is not the owner", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    const seen = requests(page);
    await page.reload(); await waitForClientOnline(page);
    // A member has no Bot directory in this App, so the conversation that opens has no Bot to read for.
    await expect(workspace(page).locator(".composer textarea")).toBeVisible();
    await page.getByLabel("消息", { exact: true }).fill("成员发一条"); await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(workspace(page).locator(".message-blocks").filter({ hasText: "好的" })).toHaveCount(1);
    await expect(page.locator(".usage-indicators")).toHaveCount(0);
    expect(seen.filter(url => url.includes("/api/engine-quotas"))).toEqual([]);
    expect(f.readings.asked).toEqual([]);
  } finally { await f.dispose(); }
});

test("ADHD panes show no symbols and ask for no readings", async ({ page }) => {
  const f = await fixture(page);
  try {
    const seen = requests(page);
    await selectConversation(page, "有读数");
    await expect(workspace(page).locator(".usage-indicators")).toBeVisible();
    const before = seen.length;
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const title of ["有读数", "只有上下文"]) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${title}`, exact: true }).check();
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await expect(page.locator(".adhd-card .composer")).toHaveCount(2);
    await expect(page.locator(".usage-indicators")).toHaveCount(0);
    const card = page.locator(`.adhd-card[data-pane-conversation="${f.both.id}"]`);
    await card.locator(".composer textarea").fill("窗口里发一条"); await card.locator(".send-button").click();
    await expect(card.locator(".message-blocks").filter({ hasText: "好的" })).toHaveCount(1);
    await expect(page.locator(".usage-indicators")).toHaveCount(0);
    expect(seen.slice(before)).toEqual([]);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await selectConversation(page, "有读数");
    await expect(workspace(page).locator(".usage-indicators")).toBeVisible();
  } finally { await f.dispose(); }
});

test("phone: nothing beside the composer and no context; quota in the more sheet; the battery alone in the header whenever quota can be read", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const seen = requests(page);
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await waitForClientOnline(page);
    const ws = workspace(page), header = ws.locator(".conversation-header");
    await selectConversation(page, "有读数");
    await expect.poll(() => seen.filter(url => url.includes("/api/engine-quotas/alpha")).length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    const row = page.getByRole("button", { name: "额度", exact: true });
    await expect(row).toBeVisible(); await expect(row.locator(".action-value")).toHaveText("80%");
    await expect(page.locator(".usage-indicators")).toHaveCount(0);
    const rows = await page.locator(".mobile-chat-action-list").filter({ has: row }).locator("button").evaluateAll(nodes => nodes.map(node => ({ text: node.querySelector(".action-label")?.textContent, height: node.getBoundingClientRect().height, overflow: node.scrollWidth - node.clientWidth })));
    expect(rows[0]!.text).toBe("额度"); expect(rows[1]!.text).toBe("连接状态与线路"); expect(rows[0]!.height).toBeCloseTo(rows[1]!.height, 0); expect(rows[0]!.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("phone-more.png"), animations: "disabled" });
    await row.click();
    const details = page.getByRole("dialog", { name: "额度", exact: true });
    await expect(details.getByRole("region", { name: "额度 · Codex", exact: true }).locator(".usage-window")).toHaveCount(2);
    await expect(details).toContainText("5 小时窗口"); await expect(details).toContainText("周额度（7 天）"); await expect(details.locator(".usage-reset-row").nth(1)).toContainText("5 天后重置"); await expect(details).not.toContainText("上下文");
    expect(await details.innerText()).not.toContain("剩");
    await page.screenshot({ path: info.outputPath("phone-details.png"), animations: "disabled" });
    await details.getByRole("button", { name: "关闭额度", exact: true }).click(); await expect(details).toBeHidden();

    // With quota to spare the battery is there too, alone where the computer's name would be: its charge is
    // what is left, in the quiet tone, and there is no number beside it (the name carries it for a screen reader).
    const spare = header.getByRole("button", { name: "额度可用 80%", exact: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(spare).toBeVisible();
      const shown = await header.evaluate(node => { const item = node.querySelector<HTMLElement>(".quota-mark")!, box = item.getBoundingClientRect(), title = node.querySelector(".header-title")!.getBoundingClientRect(), battery = item.querySelector(".usage-battery")!, charge = item.querySelector(".usage-battery-left")!;
        return { text: item.innerText.trim(), tone: battery.getAttribute("data-tone"), charge: Number(charge.getAttribute("width")), fill: getComputedStyle(charge).fill, red: getComputedStyle(node).getPropertyValue("--red"), left: box.left, right: box.right, width: box.width, titleRight: title.right, headerRight: node.getBoundingClientRect().right, overflow: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
      expect(shown.text).toBe(""); expect(shown.tone).toBe("ok"); expect(shown.charge).toBeCloseTo(13 * 0.8, 3);
      expect(shown.left).toBeGreaterThanOrEqual(shown.titleRight - 1); expect(shown.right).toBeLessThanOrEqual(shown.headerRight + 1);
      expect(shown.width).toBeGreaterThanOrEqual(32); expect(shown.overflow).toBeLessThanOrEqual(1); expect(shown.page).toBeLessThanOrEqual(0);
      await header.screenshot({ path: info.outputPath(`phone-header-spare-${width}.png`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await spare.click();
    await expect(details).toContainText("80%");
    await details.getByRole("button", { name: "关闭额度", exact: true }).click(); await expect(details).toBeHidden();

    // A Bot whose quota cannot be read shows nothing. Nearly gone: the same battery, red and all but empty.
    f.readings.value = nearlyGone();
    await selectConversation(page, "读不到"); await expect(header.locator(".quota-mark")).toHaveCount(0);
    await selectConversation(page, "有读数");
    const mark = header.getByRole("button", { name: "额度快用完了，查看额度", exact: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(mark).toBeVisible();
      await expect(header.locator(".quota-mark .usage-battery")).toHaveAttribute("data-tone", "empty");
      const layout = await header.evaluate(node => { const box = node.getBoundingClientRect(), title = node.querySelector(".header-title")!.getBoundingClientRect(), item = node.querySelector(".quota-mark")!.getBoundingClientRect(), battery = node.querySelector(".quota-mark .usage-battery-left")!;
        return { titleRight: title.right, markLeft: item.left, markRight: item.right, markWidth: item.width, right: box.right, overflow: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - innerWidth, fill: getComputedStyle(battery).fill, red: getComputedStyle(node).getPropertyValue("--red") }; });
      expect(layout.markLeft).toBeGreaterThanOrEqual(layout.titleRight - 1); expect(layout.markRight).toBeLessThanOrEqual(layout.right + 1);
      expect(layout.markWidth).toBeGreaterThanOrEqual(32); expect(layout.overflow).toBeLessThanOrEqual(1); expect(layout.page).toBeLessThanOrEqual(0);
      await header.screenshot({ path: info.outputPath(`phone-header-low-${width}.png`), animations: "disabled" });
    }
    await mark.click();
    await expect(details).toContainText("1%"); await expect(details.locator("[data-tone=empty]").first()).toBeVisible();
    await details.getByRole("button", { name: "关闭额度", exact: true }).click();
    // The phone never asked for context.
    expect(seen.filter(url => url.includes("/context-usage"))).toEqual([]);
  } finally { await f.dispose(); }
});

test("phone with two computers: the battery sits under the computer's name", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-two-hosts-"));
  const vite = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false } }); await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  const a = await HubServer.start({ stateDir: path.join(root, "a"), origins: [new URL(origin).origin] }), b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [new URL(origin).origin] });
  const readings = { value: nearlyGone(), quota: true, asked: [] as boolean[] };
  const gateway = await bot(a, root, "alpha", "codex", readings);
  async function pair(hub: HubServer, name: string, add = false) {
    await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
    if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true })); else await page.goto(origin);
    await page.getByLabel("主机名称", { exact: true }).fill(name); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
  }
  try {
    await a.store.createConversation("owner", ["alpha"], "有读数", "both");
    await pair(a, "办公室电脑"); await pair(b, "家里电脑", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await workspace(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    await workspace(page).locator(".mobile-home .mh-row").filter({ hasText: "有读数" }).click();
    const header = workspace(page).locator(".conversation-header"), low = header.getByRole("button", { name: "运行于 办公室电脑，额度快用完了，查看额度", exact: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(low).toBeVisible();
      const layout = await header.evaluate(node => { const item = node.querySelector(".header-host-usage")!, chip = item.querySelector(".host-source-badge")!.getBoundingClientRect(), battery = item.querySelector(".usage-battery")!.getBoundingClientRect(), box = item.getBoundingClientRect(), title = node.querySelector(".header-title")!.getBoundingClientRect();
        return { chipBottom: chip.bottom, batteryTop: battery.top, chipMiddle: chip.left + chip.width / 2, batteryMiddle: battery.left + battery.width / 2, left: box.left, right: box.right, headerRight: node.getBoundingClientRect().right, titleRight: title.right, titleWidth: title.width, top: box.top, bottom: box.bottom, headerTop: node.getBoundingClientRect().top, headerBottom: node.getBoundingClientRect().bottom, overflow: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
      expect(layout.batteryTop).toBeGreaterThanOrEqual(layout.chipBottom - 1);
      expect(Math.abs(layout.batteryMiddle - layout.chipMiddle)).toBeLessThan(2);
      expect(layout.left).toBeGreaterThanOrEqual(layout.titleRight - 1); expect(layout.right).toBeLessThanOrEqual(layout.headerRight + 1);
      expect(layout.top).toBeGreaterThanOrEqual(layout.headerTop - 1); expect(layout.bottom).toBeLessThanOrEqual(layout.headerBottom + 1);
      expect(layout.titleWidth).toBeGreaterThan(88); expect(layout.overflow).toBeLessThanOrEqual(1); expect(layout.page).toBeLessThanOrEqual(0);
      await header.screenshot({ path: info.outputPath(`phone-two-hosts-low-${width}.png`), animations: "disabled" });
    }
    // While a reply runs, a narrow phone shows only a dot at the end of the title row. The name with its battery
    // keeps clear of it (the dot's ring reaches 3px further) and does not run into the button after it.
    const conversationId = (await a.store.db.get<{ id: string }>("SELECT id FROM conversations WHERE title=?", ["有读数"]))!.id;
    const reply = await a.store.publishBotMessage("alpha", { conversationId, blocks: [{ type: "text", text: "正在整理" }], status: "streaming" });
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(header.locator(".header-activity .activity-dot")).toBeVisible();
      const spacing = await header.evaluate(node => { const dot = node.querySelector(".activity-dot")!.getBoundingClientRect(), group = node.querySelector(".header-host-usage")!, box = group.getBoundingClientRect(), next = group.nextElementSibling!, glyph = (next.querySelector("svg") ?? next).getBoundingClientRect();
        return { fromDot: box.left - dot.right, toNextGlyph: glyph.left - box.right, title: node.querySelector(".header-title")!.getBoundingClientRect().width, overflow: node.scrollWidth - node.clientWidth }; });
      expect(spacing.fromDot).toBeGreaterThanOrEqual(11); expect(spacing.toNextGlyph).toBeGreaterThanOrEqual(4);
      expect(spacing.title).toBeGreaterThan(88); expect(spacing.overflow).toBeLessThanOrEqual(1);
    }
    await a.store.publishBotMessage("alpha", { id: reply.id, conversationId, blocks: [{ type: "text", text: "整理好了" }], status: "complete" });
    await page.setViewportSize({ width: 320, height: 844 });
    await low.click();
    await expect(page.getByRole("dialog", { name: "额度", exact: true })).toContainText("1%");
    await page.getByRole("dialog", { name: "额度", exact: true }).getByRole("button", { name: "关闭额度", exact: true }).click();
    await expect(header.locator(".header-host-usage .usage-battery")).toHaveAttribute("data-tone", "empty");
    // With quota to spare the battery stays under the name, charged to what is left, in the quiet tone and without a number.
    readings.value = plenty();
    await workspace(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    await workspace(page).locator(".mobile-home .mh-row").filter({ hasText: "有读数" }).click();
    const spare = header.getByRole("button", { name: "运行于 办公室电脑，额度可用 80%", exact: true });
    await expect(spare).toBeVisible();
    await expect(spare.locator(".usage-battery")).toHaveAttribute("data-tone", "ok");
    expect(Number(await spare.locator(".usage-battery-left").getAttribute("width"))).toBeCloseTo(13 * 0.8, 3);
    expect(await spare.innerText()).toContain("办公室电脑"); expect(await spare.innerText()).not.toMatch(/[0-9%]/);
    const under = await spare.evaluate(node => { const chip = node.querySelector(".host-source-badge")!.getBoundingClientRect(), battery = node.querySelector(".usage-battery")!.getBoundingClientRect(); return { chipBottom: chip.bottom, batteryTop: battery.top, middle: Math.abs(chip.left + chip.width / 2 - battery.left - battery.width / 2) }; });
    expect(under.batteryTop).toBeGreaterThanOrEqual(under.chipBottom - 1); expect(under.middle).toBeLessThan(2);
    await header.screenshot({ path: info.outputPath("phone-two-hosts-plenty.png"), animations: "disabled" });
  } finally { await page.close(); await gateway.disconnect(); await a.close(); await b.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});

test("forgetting a computer on this device also forgets its saved quota readings", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/multiple-hosts.html");
    await page.waitForFunction(() => !!(window as unknown as { multipleHosts?: unknown }).multipleHosts);
    const key = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const left = await page.evaluate(async ([reset, removed]) => {
      const f = (window as unknown as { multipleHosts: typeof multipleHosts }).multipleHosts;
      const stored = () => JSON.parse(localStorage.getItem("tarobird.quotaReadings.v1") ?? "null") as unknown;
      localStorage.setItem("tarobird.quotaReadings.v1", JSON.stringify({ [reset]: { alpha: {} }, [removed]: { beta: {} }, other: { gamma: {} } }));
      // A local reset of one computer's cache.
      const a = await f.registry.add({ deviceId: "device_a", name: "A", publicKey: "fixture", hubPublicKey: reset, routes: [] }, "A");
      await (await f.registry.open(a.id))!.cache.forgetIdentity();
      const afterReset = stored();
      // Removing a computer from this device.
      const b = await f.registry.add({ deviceId: "device_b", name: "B", publicKey: "fixture", hubPublicKey: removed, routes: [] }, "B");
      await f.registry.beginRemoval(b.id);
      await f.registry.finishRemoval(b.id, b.registrationId, { shared: async () => undefined, push: async () => undefined, browser: async () => undefined, key: async () => undefined });
      return { afterReset, afterRemoval: stored() };
    }, [key(), key()] as const);
    expect(Object.keys(left.afterReset as object).length).toBe(2); expect(left.afterReset).toHaveProperty("other");
    expect(left.afterRemoval).toEqual({ other: { gamma: {} } });
  } finally { await server.close(); }
});

test("Kimi conversation UsageDetails separates Monthly vs Coding 30-day rows and excludes extra_monthly from battery", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-kimi-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
  const stateDir = path.join(root, "kimi_bot"), secret = randomBytes(32).toString("base64url");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi", model: "kimi-for-coding", locale: "zh" }));
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["kimi_bot", "Kimi Bot", hashSecret(secret)]);
  const now = Date.now(), at = new Date(now).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
  const kimiSnapshot: QuotaSnapshot = {
    authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown",
    observedAt: at, lastAttemptAt: at, constraints: [], help: "kimi_usage",
    pools: [{
      id: "kimi", label: "Kimi Code", sharing: "shared", availability: "unknown", constraints: [],
      windows: [
        { id: "five_hour", label: "5 hours", metric: "percent", usedPercent: 5, availability: "unknown", observedAt: at, expiresAt, periodSeconds: 18_000 },
        { id: "seven_day", label: "7 days", metric: "percent", usedPercent: 20, availability: "unknown", observedAt: at, expiresAt, periodSeconds: 604_800 },
        { id: "month_total", label: "Monthly", metric: "percent", usedPercent: 10, availability: "unknown", observedAt: at, expiresAt, periodSeconds: 30 * 86_400 },
        { id: "month_code", label: "Coding · 30 days", metric: "percent", usedPercent: 15, availability: "unknown", observedAt: at, expiresAt, periodSeconds: 30 * 86_400 },
        { id: "extra_monthly", label: "Top-up monthly limit", metric: "percent", usedPercent: 100, availability: "unknown", observedAt: at, expiresAt, periodSeconds: 30 * 86_400 },
      ],
      balances: [{ id: "top_up", kind: "currency", amount: "10.00", unit: "CNY", observedAt: at, expiresAt }],
    }],
  };
  const gateway = await attachGateway({
    stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "kimi_bot", engine: "kimi", model: "kimi-for-coding",
    runtime: createCoreServiceRuntime(),
    bridge: {
      handleAuthorizedMessage: async () => ({ text: "好的" }),
      readAccountQuota: async () => ({ revision: "kimi_rev", snapshot: kimiSnapshot }),
    },
  });
  try {
    await hub.store.createConversation("owner", ["kimi_bot"], "Kimi 额度", "kimi_conv");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await selectConversation(page, "Kimi 额度");
    const ws = workspace(page), indicators = ws.locator(".usage-indicators"), battery = indicators.locator("[data-usage=quota]");
    // 100%-used extra_monthly must NOT drop battery from 80% (seven_day remaining) to 0%.
    await expect(battery).toHaveText("80%");
    await expect(battery).toHaveAttribute("data-tone", "ok");
    await indicators.click();
    const panel = page.getByRole("group", { name: "上下文与额度", exact: true });
    const rows = panel.getByRole("region", { name: "额度 · Kimi Code", exact: true }).locator(".usage-window");
    await expect(rows).toHaveCount(4);
    // Window names after #77; the monthly total and the coding window stay two rows with two names.
    await expect(rows.locator(".usage-window-label")).toHaveText(["5 小时窗口", "周额度（7 天）", "30 天窗口", "编程 · 30 天窗口"]);
  } finally {
    await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("in-chat quota details tick live countdowns and honor serverTimeOffset", async ({ page }) => {
  // Simulate Host clock 1 hour ahead of browser clock
  const hostAheadMs = 3_600_000;
  await page.routeWebSocket("**/ws", socket => {
    const upstream = socket.connectToServer();
    upstream.onMessage(message => {
      if (typeof message !== "string") return socket.send(message);
      const frame = JSON.parse(message);
      if (frame.type === "ready" && typeof frame.serverTime === "number") {
        frame.serverTime += hostAheadMs;
        frame.expiresAt += hostAheadMs;
      }
      socket.send(JSON.stringify(frame));
    });
  });
  const f = await fixture(page);
  try {
    // Re-reading the same windows must preserve their absolute reset times.
    const hostNow = Date.now() + hostAheadMs;
    f.readings.value = {
      limits: [
        { id: "primary", used: 20, period: 18_000, resetsAt: new Date(hostNow + 64_500).toISOString() },
        { id: "secondary", used: 10, period: 604_800, resetsAt: new Date(hostNow + 2 * 3_600_000).toISOString() },
      ],
    };
    const ws = workspace(page), indicators = ws.locator(".usage-indicators");
    await selectConversation(page, "有读数");
    await expect(indicators.locator("[data-usage=quota]")).toHaveText("80%");
    await indicators.click();
    const panel = page.getByRole("group", { name: "上下文与额度", exact: true });
    await expect(panel).toBeVisible();
    const windows = panel.locator(".usage-window");
    await expect(windows.nth(0)).toContainText("2 分钟后重置");
    await expect(windows.nth(1)).toContainText("2 小时后重置");
    // While the popover stays open, its live timer ticks down from 2 min to 1 min without reopening
    await expect(windows.nth(0)).toContainText("1 分钟后重置", { timeout: 8_000 });
  } finally { await f.dispose(); }
});

test("stale low/empty quota progress bars render grey, cold offline reload shows cached battery, and 403 evicts it (#137)", async ({ page }) => {
  const f = await fixture(page);
  try {
    const ws = workspace(page), indicators = ws.locator(".usage-indicators"), battery = indicators.locator("[data-usage=quota]");
    f.readings.value = nearlyGone();
    await selectConversation(page, "有读数");
    await expect(battery).toHaveText("1%");
    await expect(battery).toHaveAttribute("data-tone", "empty");

    // Cold reload while WebSocket is blocked: the last selected conversation opens offline and its saved battery
    // appears immediately marked stale (greyed out), with muted grey progress bars inside the details popover.
    const seen = requests(page);
    let blockWs = true;
    await page.routeWebSocket("**/ws", socket => {
      if (blockWs) { socket.close(); return; }
      socket.connectToServer();
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "有读数", exact: true, level: 1 })).toBeVisible();
    await expect(battery).toHaveText("1%");
    await expect(battery).toHaveAttribute("data-stale", "true");
    await indicators.click();
    const panel = page.getByRole("group", { name: "上下文与额度", exact: true });
    await expect(panel.locator(".usage-stale-banner")).toBeVisible();
    const barColors = await panel.evaluate(node => {
      const fills = [...node.querySelectorAll(".usage-bar[data-stale=true] > i")];
      const probe = document.createElement("span");
      probe.style.color = "var(--red)";
      node.append(probe);
      const red = getComputedStyle(probe).color;
      probe.style.color = "var(--muted)";
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return {
        count: fills.length,
        allMuted: fills.every(fill => getComputedStyle(fill).backgroundColor === muted),
        noneRed: fills.every(fill => getComputedStyle(fill).backgroundColor !== red),
        noneHaveTone: fills.every(fill => !fill.hasAttribute("data-tone")),
      };
    });
    expect(barColors).toEqual({ count: 2, allMuted: true, noneRed: true, noneHaveTone: true });
    expect(seen.filter(url => url.includes("/api/engine-quotas"))).toEqual([]);

    // Reconnect online with owner role revoked via 403 on quota endpoint: evicts cached battery and storage immediately.
    blockWs = false;
    await page.route("**/api/engine-quotas/*", route => route.fulfill({ status: 403, json: { error: "forbidden" } }));
    await page.reload();
    await waitForClientOnline(page);
    await expect(page.getByRole("heading", { name: "有读数", exact: true, level: 1 })).toBeVisible();
    await expect(battery).toHaveCount(0);
    const savedAfter403 = await page.evaluate(() => localStorage.getItem("tarobird.quotaReadings.v1") ?? "{}");
    expect(savedAfter403).not.toContain("alpha");
  } finally { await f.dispose(); }
});

test("workspace env card: quota row beside the context row, plain latency, and a small status tag", async ({ page }) => {
  const f = await fixture(page);
  try {
    await selectConversation(page, "有读数");
    await expect(workspace(page).locator(".usage-indicators [data-usage=quota]")).toHaveText("80%");
    await workspace(page).getByRole("button", { name: "会话工作区", exact: true }).click();
    const card = page.locator("aside.conversation-workspace-rail .workspace-env-card");
    await expect(card.locator(".workspace-memory-row").first()).toContainText("剩 62%");
    const quotaRow = card.locator(".workspace-quota-row");
    await expect(quotaRow).toContainText("额度");
    await expect(quotaRow).toContainText("剩 80%");
    await expect(quotaRow.getByRole("meter", { name: "额度" })).toHaveAttribute("aria-valuenow", "80");
    // Every window and its reset are in the tooltip; the row shows the tightest one.
    const title = await quotaRow.getAttribute("title");
    expect(title?.split("\n")).toHaveLength(2);
    expect(title).toContain("剩 80%"); expect(title).toContain("剩 90%"); expect(title).toContain("后重置");
    // Latency is just a number (or a connection word), never an adjective.
    await expect(card.locator(".workspace-env-signal")).toHaveText(/^(\d+ms|已连上)$/);
    // The workspace picker's 32px chip rule no longer leaks into the card's status tag.
    const chip = await card.locator(".workspace-env-meta .workspace-chip.is-online").evaluate(node => { const style = getComputedStyle(node); return { height: node.getBoundingClientRect().height, minHeight: style.minHeight }; });
    expect(chip.minHeight).not.toBe("32px"); expect(chip.height).toBeLessThan(24);
    // A Bot whose quota cannot be read has no quota row.
    await selectConversation(page, "读不到");
    await expect(page.locator("aside.conversation-workspace-rail .workspace-env-card")).toBeVisible();
    await expect(page.locator("aside.conversation-workspace-rail .workspace-quota-row")).toHaveCount(0);
  } finally { await f.dispose(); }
});
