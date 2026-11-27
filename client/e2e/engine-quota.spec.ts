import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { QuotaSnapshot } from "../../src/client-protocol/engine-quota.js";
import { unavailableQuota } from "../../src/codex/account-quota.js";
import { proveQuotaAccount } from "../../src/runtime/engine-quota-scope.js";
import { fixtureInvitation } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import en from "../src/locales/en.json" with { type: "json" };

// Settings › Model quotas is part of an ordinary build again (src/engine-quota-feature.ts), so every test here
// uses `dist`. TAROBIRD_QUOTA_TEST_CLIENT_DIR still points the page tests at another client directory.
const quotaUiClient = process.env.TAROBIRD_QUOTA_TEST_CLIENT_DIR;

type RecordState = {
  revision: string;
  snapshot: QuotaSnapshot;
  reads: number;
  refreshes: number;
  hold?: Promise<void>;
  account?: { accountId: string; userId: string };
  onRefresh?: () => Promise<void> | void;
  readSnapshot?: (refresh: boolean) => QuotaSnapshot;
};
async function fixture(page: Page, english = false, oldHost = false, extraBots: ReadonlyArray<readonly [string, string, "codex" | "claude" | "kimi"]> = []) {
  const text = (key: string) => english ? (en as Record<string, string>)[key] || key : key;
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-quota-ui-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: quotaUiClient ?? path.resolve("dist") });
  await hub.profile.update({ name: "Quota fixture Host", revision: (await hub.profile.read()).revision });
  const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
  const ready = (used: number): QuotaSnapshot => ({ authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(), pools: [{ id: "native_pool", label: "Native shared pool", sharing: "shared", availability: "allowed", windows: [
    { id: "short", label: "5 hours", metric: "percent", usedPercent: used, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp(120_000), periodSeconds: 18_000 },
    { id: "week", label: "Weekly", metric: "unknown", availability: "unknown", observedAt: stamp(), expiresAt: stamp(60_000) },
  ], balances: [{ id: "credits", kind: "credits", unit: "credits", amount: "12.50", observedAt: stamp(), expiresAt: stamp(60_000) }], constraints: [] }], constraints: [] });
  const records: Record<string, RecordState> = {
    coder: { revision: "coder_one", snapshot: ready(38), reads: 0, refreshes: 0 },
    reviewer: { revision: "reviewer_one", snapshot: ready(125), reads: 0, refreshes: 0 },
    writer: { revision: "writer_one", snapshot: unavailableQuota("claude", "no_passive_event"), reads: 0, refreshes: 0 },
    research: { revision: "research_one", snapshot: unavailableQuota("kimi", "not_adapted"), reads: 0, refreshes: 0 },
  };
  for (const [id, , engine] of extraBots) {
    records[id] = { revision: `${id}_one`, snapshot: unavailableQuota(engine, "not_loaded"), reads: 0, refreshes: 0 };
  }
  const gateways = []; let turns = 0, quotaRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/engine-quotas")) quotaRequests++; });
  if (oldHost) await page.routeWebSocket("**/ws", socket => {
    const upstream = socket.connectToServer(); upstream.onMessage(message => {
      if (typeof message !== "string") return socket.send(message);
      const frame = JSON.parse(message);
      if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((value: string) => value !== "engines.quota.v1");
      socket.send(JSON.stringify(frame));
    });
  });
  const bots = [
    ["coder", "Coding Bot", "codex"],
    ["reviewer", "Review Bot", "codex"],
    ["writer", "Writing Bot", "claude"],
    ["research", "Research Bot", "kimi"],
    ...extraBots,
  ] as const;
  for (const [id, name, engine] of bots) {
    const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine })); await writeFile(path.join(stateDir, "session.json"), "unchanged-session");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
    gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async () => { turns++; throw new Error("quota_must_not_send_a_turn"); },
      readAccountQuota: async options => {
        const record = records[id]!;
        record.reads++;
        if (options.refresh) { record.refreshes++; await record.hold; await record.onRefresh?.(); }
        const proof = record.account && options.accountProofKey
          ? proveQuotaAccount(options.accountProofKey, { engine, scopeStamp: record.revision, accountId: record.account.accountId, userId: record.account.userId })
          : undefined;
        return { revision: record.revision, snapshot: record.readSnapshot ? record.readSnapshot(options.refresh) : record.snapshot, ...(proof ? { proof } : {}) };
      },
    } }));
  }
  await page.goto(hub.url); const invitation = await fixtureInvitation(hub);
  await page.getByRole("button", { name: text("粘贴连接信息"), exact: true }).click();
  await page.getByLabel(text("配对信息"), { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
  await page.getByRole("button", { name: text("使用配对信息"), exact: true }).click();
  await page.getByRole("button", { name: text("配对此设备"), exact: true }).click();
  await hub.auth.approve(await page.getByLabel(text("配对码"), { exact: true }).innerText(), "local-owner");
  await page.getByLabel(text("配对码"), { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeAttached();
  const openSettings = async () => {
    if (page.viewportSize()!.width <= 760) {
      await page.getByRole("navigation", { name: text("主导航") }).getByRole("button", { name: text("我的"), exact: true }).click();
    }
    await page.getByRole("button", { name: text("设置"), exact: true }).filter({ visible: true }).click();
  };
  return { text, records, hub, requests: () => quotaRequests, openSettings, async open() {
    await openSettings();
    await page.getByRole("navigation", { name: text("设置分类") }).getByRole("button", { name: new RegExp(`^${text("模型额度")}`) }).click();
  }, async close() {
    expect(turns).toBe(0); expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
    for (const id of Object.keys(records)) expect(await readFile(path.join(root, id, "session.json"), "utf8")).toBe("unchanged-session");
    await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
  } };
}

test.use({ serviceWorkers: "block", actionTimeout: 10_000 });
for (const [width, english] of [[1360, false], [1360, true], [390, false], [390, true]] as const) test(`the owner finds Model quotas in Settings, and nothing is read before it is opened, at ${width}px ${english ? "en" : "zh"}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, english);
  try {
    await f.openSettings(); const navigation = page.getByRole("navigation", { name: f.text("设置分类") });
    const entry = navigation.getByRole("button", { name: new RegExp(`^${f.text("模型额度")}`) });
    await expect(entry).toBeVisible();
    // Opening Settings alone asks the Host nothing about quotas.
    expect(f.requests()).toBe(0);
    await entry.click();
    const panel = page.locator(".engine-quota:visible");
    await expect(panel.getByRole("region", { name: "Coding Bot · Codex", exact: true })).toBeVisible();
    // An engine this Host cannot read is listed and says so; it is not left out.
    await expect(panel.getByRole("region", { name: "Research Bot · Kimi", exact: true })).toContainText(f.text("此引擎尚未接入原生额度。"));
    expect(f.requests()).toBeGreaterThan(0);
  } finally { await f.close(); await context.close(); }
});

test("quota page reads actual Host cache and explicit refresh never sends a model turn", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await f.open(); const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%"); await expect(coder).toContainText("12.50 credits");
    await expect(coder).toContainText("尚无数据"); expect(f.records.coder!.refreshes).toBe(0);
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => f.records.coder!.refreshes).toBe(1);
    const writer = panel.getByRole("region", { name: "Writing Bot · Claude Code", exact: true });
    await writer.getByRole("button", { name: "读取已知状态", exact: true }).click(); await expect.poll(() => f.records.writer!.reads).toBeGreaterThan(1);
    expect(f.records.writer!.refreshes).toBe(0);
    await expect(panel.getByRole("region", { name: "Review Bot · Codex", exact: true })).toContainText("超出 25%");
    await expect(panel.getByRole("region", { name: "Research Bot · Kimi", exact: true })).toContainText("尚未接入");
    await expect(panel.getByRole("region", { name: "Research Bot · Kimi", exact: true }).locator(".quota-help")).toHaveText("官方查看：在 Kimi Code CLI 交互界面输入 /usage 查看套餐额度；ACP 会话里的 /usage 只显示本会话 token。");
    await expect(writer.locator(".quota-help")).toContainText("claude.ai/settings/usage");
    await expect(coder.locator(".quota-help")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("quota-desktop.png"), fullPage: true });
  } finally { await f.close(); }
});

for (const width of [1360, 390, 320]) for (const english of [false, true]) test(`quota values and independent restrictions fit ${width}px ${english ? "en" : "zh"}`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, english), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    f.records.reviewer!.snapshot.availability = "blocked";
    f.records.reviewer!.snapshot.constraints = [{ code: "spend_control", availability: "blocked" }];
    f.records.reviewer!.snapshot.pools[0]!.balances[0]!.amount = null;
    await f.open(); const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true }), reviewer = panel.getByRole("region", { name: "Review Bot · Codex", exact: true });
    await expect(coder).toContainText(english ? "62% remaining" : "剩余 62%"); await expect(coder.getByRole("meter")).toHaveCount(1);
    await expect(reviewer).toContainText(f.text("已触发原生消费限制")); await expect(reviewer).toContainText(english ? "25% over limit" : "超出 25%");
    await expect(reviewer.locator(".quota-balance")).toContainText(f.text("尚无数据")); await expect(reviewer.locator(".quota-balance")).not.toContainText("0 credits");
    const research = panel.getByRole("region", { name: "Research Bot · Kimi", exact: true });
    await expect(research.locator(".quota-help")).toHaveText(f.text("官方查看：在 Kimi Code CLI 交互界面输入 /usage 查看套餐额度；ACP 会话里的 /usage 只显示本会话 token。"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.locator(".quota-card").evaluateAll(cards => cards.every(card => card.scrollWidth <= card.clientWidth + 1))).toBe(true);
    await coder.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-values.png") });
    await reviewer.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-restrictions.png") });
    await research.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-guidance.png") });
    for (const record of Object.values(f.records)) expect(record.refreshes).toBe(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); await context.close(); }
});

test("quota expiry never invents a refill or issues a refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    const value = f.records.coder!.snapshot.pools[0]!.windows[0]!; value.resetsAt = new Date(Date.now() + 1800).toISOString();
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%"); const requests = f.requests();
    await expect(coder).toContainText("已到重置时间，等待更新");
    await expect(coder).toContainText("上次读数：剩余 62%"); await expect(coder).not.toContainText("剩余 100%");
    expect(f.requests()).toBe(requests); expect(f.records.coder!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("constraints-only quota readings expire locally without any network refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    const snapshot = f.records.coder!.snapshot;
    snapshot.pools = []; snapshot.availability = "blocked";
    snapshot.constraints = [{ code: "ordinary_usage_blocked", availability: "blocked" }];
    snapshot.observedAt = new Date(Date.now() - 57_000).toISOString();
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder.locator(".quota-state")).toHaveText("已读取");
    await expect(coder).toContainText("常规使用受限"); await expect(coder.getByRole("meter")).toHaveCount(0);
    const requests = f.requests();
    await expect(coder.locator(".quota-state")).toHaveText("待更新", { timeout: 6_000 });
    await expect(coder).toContainText("常规使用受限"); await expect(coder).not.toContainText("剩余 100%");
    expect(f.requests()).toBe(requests); expect(f.records.coder!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("constraint reset times expire the reading like the Gateway, without a refill or refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    const snapshot = f.records.coder!.snapshot;
    // Mirrors parseCodexQuota: native Codex readings carry their official viewing guidance.
    snapshot.pools = []; snapshot.availability = "blocked"; snapshot.observedAt = new Date().toISOString(); snapshot.help = "codex_usage";
    snapshot.constraints = [{ code: "ordinary_usage_blocked", availability: "blocked", resetsAt: new Date(Date.now() + 4_000).toISOString() }];
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }), constraints = coder.locator(".quota-constraints");
    await expect(coder.locator(".quota-state")).toHaveText("已读取"); await expect(constraints).toContainText("分钟后重置"); await expect(coder.locator(".quota-help")).toHaveCount(0);
    await expect(coder.locator(".quota-notice")).toHaveText("原生服务报告使用受限；窗口剩余量不代表可以继续请求。");
    const requests = f.requests();
    await expect(coder.locator(".quota-state")).toHaveText("待更新", { timeout: 8_000 });
    await expect(constraints).toContainText("常规使用受限 · 已到重置时间，等待更新"); await expect(constraints).not.toContainText("分钟后重置");
    await expect(coder.locator(".quota-notice")).toHaveText("上次读数：原生服务报告使用受限；窗口剩余量不代表可以继续请求。");
    await expect(coder.locator(".quota-help")).toContainText("/usage");
    await expect(coder).not.toContainText("剩余 100%");
    expect(f.requests()).toBe(requests); expect(f.records.coder!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("quota authentication changes clear old values and require another explicit refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }); await expect(coder).toContainText("剩余 62%");
    f.records.coder!.revision = "coder_new_authorization";
    await coder.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(coder).toContainText("授权信息已变化"); await expect(coder).not.toContainText("剩余 62%"); expect(f.records.coder!.refreshes).toBe(0);
    await coder.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => f.records.coder!.refreshes).toBe(1); await expect(coder).toContainText("剩余 62%");
  } finally { await f.close(); }
});

test("quota cards refresh independently and owner revocation clears all data", async ({ page }) => {
  const f = await fixture(page); let release = () => {};
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }), reviewer = page.getByRole("region", { name: "Review Bot · Codex", exact: true });
    f.records.coder!.hold = new Promise<void>(resolve => { release = resolve; });
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => f.records.coder!.refreshes).toBe(1);
    await reviewer.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => f.records.reviewer!.refreshes).toBe(1);
    await expect(reviewer).toContainText("后可再刷新"); await expect(coder).toHaveAttribute("aria-busy", "true");
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"); release();
    await expect(page.locator(".engine-quota").getByRole("alert")).toContainText("额度查看权限已变化"); await expect(page.locator(".quota-card")).toHaveCount(0);
    const before = f.requests(); await page.reload(); await expect(page.locator(".connection-pill.online")).toBeAttached(); await f.openSettings();
    await expect(page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型额度/ })).toHaveCount(0); expect(f.requests()).toBe(before);
  } finally { release(); await f.close(); }
});

test("old Hosts show an upgrade explanation without probing quota endpoints", async ({ page }) => {
  const f = await fixture(page, false, true);
  try { await f.open(); await expect(page.locator(".engine-quota")).toContainText("请更新主机以查看模型额度"); expect(f.requests()).toBe(0); }
  finally { await f.close(); }
});

test("closing and locking quota settings discard late responses and never replay native refresh", async ({ page }) => {
  const f = await fixture(page); let release = () => {}; let held = false;
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }); await expect(coder).toContainText("剩余 62%");
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/engine-quotas/coder?*", async route => { const response = await route.fetch(); held = true; await gate; await route.fulfill({ response }).catch(() => undefined); });
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    const window = f.records.coder!.snapshot.pools[0]!.windows[0]!; if (window.metric === "percent") window.usedPercent = 91;
    await f.open(); await expect(coder).toContainText("剩余 9%"); release(); await expect(coder).not.toContainText("剩余 62%");
    expect(f.records.coder!.refreshes).toBe(1);
    await page.evaluate(() => { document.documentElement.dataset.mobileLocked = "true"; });
    await expect(page.locator(".quota-card")).toHaveCount(0); const before = f.requests();
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); }); expect(f.requests()).toBe(before);
    await page.evaluate(() => { document.documentElement.dataset.mobileLocked = "false"; }); await expect(coder).toContainText("剩余 9%"); expect(f.records.coder!.refreshes).toBe(1);
  } finally { release(); await f.close(); }
});

test("quota discovery keeps not-loaded, unsupported, offline and partial directories distinct and auto-reads readable cards on open", async ({ page }) => {
  const f = await fixture(page);
  try {
    f.records.coder!.snapshot = unavailableQuota("codex", "not_loaded");
    f.records.reviewer!.snapshot = unavailableQuota("codex", "offline");
    await page.route(/\/api\/engine-quotas(?:\?.*)?$/, async route => {
      const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), truncated: true } });
    });
    await f.open(); const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(panel).toContainText("只返回了部分 Bot");
    // Readable active cards without data auto-refresh once on page open without manual clicking.
    await expect.poll(() => f.records.coder!.refreshes).toBe(1);
    await expect(coder).toContainText("尚未读取原生额度");
    await expect(coder.getByRole("meter")).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "Review Bot · Codex", exact: true })).toContainText("当前离线");
    for (const name of ["Review Bot · Codex", "Research Bot · Kimi"]) await expect(panel.getByRole("region", { name, exact: true }).getByRole("button")).toHaveCount(0);
    expect(f.records.reviewer!.refreshes).toBe(0);
    expect(f.records.research!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("model quotas auto-read stale/empty cards on open and update automatically when a slow Claude answer arrives late", async ({ page }) => {
  const f = await fixture(page);
  try {
    const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
    const readyCodex: QuotaSnapshot = {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(),
      pools: [{
        id: "codex_pool", label: "Codex", sharing: "shared", availability: "allowed",
        windows: [{ id: "secondary", label: "Secondary", metric: "percent", usedPercent: 18, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp((3 * 24 + 17) * 3_600_000), periodSeconds: 604_800 }],
        balances: [], constraints: [],
      }], constraints: [],
    };
    const readyClaude: QuotaSnapshot = {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(5_000),
      pools: [{
        id: "claude_pool", label: "Claude", sharing: "shared", availability: "allowed",
        windows: [{ id: "seven_day", label: "7 days", metric: "percent", usedPercent: 26, availability: "allowed", observedAt: stamp(5_000), expiresAt: stamp(65_000), resetsAt: stamp((4 * 24 + 5) * 3_600_000), periodSeconds: 604_800 }],
        balances: [], constraints: [],
      }], constraints: [],
    };
    // Mirror real ClaudeStreamAdapter: refresh=true times out without caching "timeout", so subsequent
    // refresh=false cache polls return "not_loaded" until the late answer arrives.
    let claudeTimedOut = false, claudeAnswerReady = false, notLoadedPolls = 0;
    f.records.coder!.readSnapshot = refresh => {
      if (refresh) f.records.coder!.snapshot = readyCodex;
      return f.records.coder!.snapshot;
    };
    f.records.coder!.snapshot = unavailableQuota("codex", "not_loaded");
    f.records.writer!.readSnapshot = refresh => {
      if (claudeAnswerReady) return readyClaude;
      if (refresh) {
        claudeTimedOut = true;
        return { ...unavailableQuota("claude", "timeout"), capability: { mode: "active" }, authMode: "subscription" };
      }
      if (claudeTimedOut) notLoadedPolls++;
      return { ...unavailableQuota("claude", "not_loaded"), capability: { mode: "active" }, authMode: "subscription" };
    };

    await f.open();
    const panel = page.locator(".engine-quota:visible");
    const coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    const writer = panel.getByRole("region", { name: "Writing Bot · Claude Code", exact: true });

    // Both cards started reading automatically on open without clicking Refresh.
    await expect(coder).toContainText("剩余 82%");
    await expect(coder).toContainText("3 天 17 小时");
    await expect.poll(() => claudeTimedOut).toBe(true);
    // Slow Claude stays in "正在读取…" across real "not_loaded" cache-only polls.
    await expect.poll(() => notLoadedPolls, { timeout: 8_000 }).toBeGreaterThanOrEqual(1);
    await expect(writer.locator(".quota-state")).toHaveText("正在读取…");
    await expect(writer).not.toContainText("读取原生额度超时");

    // Late answer arrives on the Host cache; the Settings card picks it up automatically.
    claudeAnswerReady = true;
    await expect(writer).toContainText("剩余 74%", { timeout: 10_000 });
    await expect(writer).toContainText("4 天 5 小时");
    await expect(writer.locator(".quota-state")).toHaveText("已读取");
  } finally { await f.close(); }
});

test("slow Claude late-answer polling aborts on close and clears data on owner revocation", async ({ page }) => {
  const f = await fixture(page);
  let releasePoll = () => {};
  try {
    let claudeTimedOut = false;
    f.records.writer!.readSnapshot = refresh => {
      if (refresh) {
        claudeTimedOut = true;
        return { ...unavailableQuota("claude", "timeout"), capability: { mode: "active" }, authMode: "subscription" };
      }
      return { ...unavailableQuota("claude", "not_loaded"), capability: { mode: "active" }, authMode: "subscription" };
    };
    let pollStarted = false, pollAborted = false;
    const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
    page.on("requestfailed", req => {
      if (new URL(req.url()).pathname === "/api/engine-quotas/writer" && !req.url().includes("refresh=1")) pollAborted = true;
    });
    // A cache read of this Bot (it may carry ?balances=currency), never its refresh.
    const writerCacheRead = (url: URL) => url.pathname === "/api/engine-quotas/writer" && !url.searchParams.has("refresh");
    await page.route(writerCacheRead, async route => {
      pollStarted = true;
      await pollGate;
      await route.continue().catch(() => undefined);
    });

    await f.open();
    const writer = page.locator(".engine-quota:visible").getByRole("region", { name: "Writing Bot · Claude Code", exact: true });
    await expect.poll(() => claudeTimedOut).toBe(true);
    await expect(writer.locator(".quota-state")).toHaveText("正在读取…");
    await expect.poll(() => pollStarted, { timeout: 8_000 }).toBe(true);

    // Closing Settings aborts the in-flight cache poll immediately.
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect.poll(() => pollAborted).toBe(true);
    releasePoll();
    await page.unroute(writerCacheRead);

    // Reopen under a fresh revision, enter watchLateAnswer, and revoke owner permission.
    claudeTimedOut = false;
    f.records.writer!.revision = "writer_two";
    await f.open();
    await expect.poll(() => claudeTimedOut).toBe(true);
    await expect(writer.locator(".quota-state")).toHaveText("正在读取…");
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await expect(page.locator(".engine-quota").getByRole("alert")).toContainText("额度查看权限已变化", { timeout: 8_000 });
    await expect(page.locator(".quota-card")).toHaveCount(0);
  } finally { releasePoll(); await f.close(); }
});

test("auto-refresh queues ten readable cards, reads them two at a time and fills all of them", async ({ page }) => {
  const extraBots = Array.from({ length: 8 }, (_, index) => [`worker_${index + 1}`, `Worker ${index + 1}`, "codex"] as const);
  const f = await fixture(page, false, false, extraBots);
  try {
    const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
    const readyCodex = (used: number): QuotaSnapshot => ({
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(),
      pools: [{
        id: "codex_pool", label: "Codex", sharing: "shared", availability: "allowed",
        windows: [{ id: "short", label: "5 hours", metric: "percent", usedPercent: used, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp(2 * 3_600_000), periodSeconds: 18_000 }],
        balances: [], constraints: [],
      }], constraints: [],
    });
    const activeIds = ["coder", "reviewer", ...extraBots.map(([id]) => id)];
    let inFlight = 0, maxInFlight = 0;
    for (const [index, id] of activeIds.entries()) {
      const record = f.records[id]!;
      record.snapshot = unavailableQuota("codex", "not_loaded");
      record.onRefresh = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 120));
        record.snapshot = readyCodex(10 + index);
        inFlight--;
      };
    }

    await f.open();
    const panel = page.locator(".engine-quota:visible");
    // All 10 readable cards refresh automatically without manual clicking.
    await expect.poll(() => activeIds.every(id => f.records[id]!.refreshes === 1), { timeout: 15_000 }).toBe(true);
    // MAX_CONCURRENT_QUOTA_REFRESH: the page never has more than two native reads in flight.
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    for (const [index, name] of ["Coding Bot", "Review Bot", ...extraBots.map(([, label]) => label)].entries()) {
      const card = panel.getByRole("region", { name: `${name} · Codex`, exact: true });
      await expect(card).toContainText(`剩余 ${90 - index}%`);
      await expect(card.locator(".quota-state")).toHaveText("已读取");
    }
  } finally { await f.close(); }
});

test("a failed quota card preserves marked old values while a retired scope only reloads the cache", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }), reviewer = page.getByRole("region", { name: "Review Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%");
    await page.route("**/api/engine-quotas/coder?*", route => route.fulfill({ status: 503, json: { error: "unavailable" } }));
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect(coder.getByRole("alert")).toContainText("本次刷新失败");
    await expect(coder).toContainText("上次读数：剩余 62%"); await expect(reviewer.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await page.unroute("**/api/engine-quotas/coder?*");
    await page.route("**/api/engine-quotas/coder?*", route => route.fulfill({ status: 409, json: { error: "quota_scope_changed" } }));
    const before = f.records.coder!.reads;
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect(page.locator(".engine-quota")).toContainText("已重新读取列表");
    await expect.poll(() => f.records.coder!.reads).toBeGreaterThan(before); expect(f.records.coder!.refreshes).toBe(0);
    await expect(coder).toContainText("剩余 62%"); await expect(coder.getByRole("alert")).toHaveCount(0);
  } finally { await f.close(); }
});

test("Kimi quota card renders plan windows, top-up balance, and distinct 404 / API-key / login-required explanations", async ({ page }) => {
  const f = await fixture(page);
  try {
    const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
    f.records.research!.snapshot = {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(),
      pools: [{
        id: "kimi", label: "Kimi Code", sharing: "shared", availability: "allowed",
        windows: [
          { id: "five_hour", label: "5 hours", metric: "percent", usedPercent: 12, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp(2 * 3_600_000), periodSeconds: 18_000 },
          { id: "seven_day", label: "7 days", metric: "percent", usedPercent: 30, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp(5 * 86_400_000), periodSeconds: 604_800 },
          { id: "month_total", label: "Monthly", metric: "percent", usedPercent: 20, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), periodSeconds: 30 * 86_400 },
          { id: "month_code", label: "Coding · 30 days", metric: "percent", usedPercent: 25, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), periodSeconds: 30 * 86_400 },
        ],
        balances: [{ id: "top_up", kind: "currency", unit: "CNY", amount: "45.50", observedAt: stamp(), expiresAt: stamp(60_000) }],
        constraints: [],
      }],
      constraints: [],
      help: "kimi_usage",
    };
    await f.open();
    const panel = page.locator(".engine-quota:visible");
    const kimi = panel.getByRole("region", { name: "Research Bot · Kimi", exact: true });
    await expect(kimi).toContainText("剩余 88%");
    await expect(kimi).toContainText("剩余 70%");
    // Window lengths are names now (#77); Kimi's coding scope keeps its prefix, in the App's language.
    await expect(kimi.locator(".quota-window-name")).toHaveText(["5 小时窗口", "周额度（7 天）", "30 天窗口", "编程 · 30 天窗口"]);
    await expect(kimi).toContainText("加油包余额");
    await expect(kimi).toContainText("45.50 CNY");

    // 404 non-Kimi-For-Coding explanation keeps Refresh enabled so plan upgrades are discoverable.
    f.records.research!.snapshot = { ...unavailableQuota("kimi", "mode_not_supported", now, "other"), capability: { mode: "active", reason: "mode_not_supported" } };
    await panel.getByRole("button", { name: "重新读取列表", exact: true }).click();
    await expect(kimi).toContainText("不是 Kimi For Coding 套餐账号");
    await expect(kimi.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();

    // API key only explanation hides Refresh because credential mode is local-only.
    f.records.research!.snapshot = unavailableQuota("kimi", "mode_not_supported", now, "api_key");
    await panel.getByRole("button", { name: "重新读取列表", exact: true }).click();
    await expect(kimi).toContainText("仅配置了 API Key");
    await expect(kimi.getByRole("button")).toHaveCount(0);

    // Not signed in explanation.
    f.records.research!.snapshot = unavailableQuota("kimi", "login_required", now, "unknown");
    await panel.getByRole("button", { name: "重新读取列表", exact: true }).click();
    await expect(kimi).toContainText("完成引擎登录");
  } finally { await f.close(); }
});

test("upgraded App negotiates currency balances for DeepSeek and displays Pi provider guidance", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-quota-currency-ui-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: quotaUiClient ?? path.resolve("dist") });
  await hub.profile.update({ name: "Quota currency Host", revision: (await hub.profile.read()).revision });
  const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
  const snapshots: Record<string, QuotaSnapshot> = {
    deepseek: {
      authMode: "subscription",
      capability: { mode: "active" },
      state: "ready",
      availability: "unknown",
      observedAt: stamp(),
      lastAttemptAt: stamp(),
      pools: [{
        id: "deepseek_wallet",
        label: "DeepSeek",
        sharing: "shared",
        availability: "unknown",
        windows: [],
        balances: [
          { id: "recharge_cny", kind: "currency", unit: "CNY", amount: "42.00", observedAt: stamp(), expiresAt: stamp(60_000) },
          { id: "bonus_cny", kind: "currency", unit: "CNY", amount: "5.25", observedAt: stamp(), expiresAt: stamp(60_000) },
        ],
        constraints: [],
      }],
      constraints: [],
      help: "deepseek_balance",
    },
    pi: unavailableQuota("pi", "mode_not_supported", now, "other"),
  };
  const gateways = [];
  try {
    for (const [id, name, engine] of [["deepseek", "DeepSeek Bot", "deepseek"], ["pi", "Pi Bot", "pi"]] as const) {
      const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url");
      await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,?)", [id, name, hashSecret(secret), engine]);
      gateways.push(await attachGateway({
        stateDir,
        url: hub.instanceUrl.replace("http", "ws") + "/instance",
        secret,
        botId: id,
        engine,
        runtime: createCoreServiceRuntime(),
        bridge: {
          handleAuthorizedMessage: async () => { throw new Error("quota_must_not_send_a_turn"); },
          readAccountQuota: async () => ({ revision: `${id}_rev`, snapshot: snapshots[id]! }),
        },
      }));
    }
    await page.goto(hub.url);
    const invitation = await fixtureInvitation(hub);
    await page.getByRole("button", { name: "粘贴连接信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
    await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeAttached();
    await page.getByRole("button", { name: "设置", exact: true }).filter({ visible: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型额度/ }).click();

    const panel = page.locator(".engine-quota:visible");
    const dsh = panel.getByRole("region", { name: "DeepSeek Bot · DeepSeek", exact: true });
    await expect(dsh).toContainText("充值余额");
    await expect(dsh).toContainText("42.00 CNY");
    await expect(dsh).toContainText("赠送余额");
    await expect(dsh).toContainText("5.25 CNY");

    const pi = panel.getByRole("region", { name: "Pi Bot · Pi", exact: true });
    await expect(pi).toContainText("当前供应商不提供可读取的账号额度（Pi 仅统计本会话 token 与费用）。");
    await expect(pi.getByRole("button")).toHaveCount(0);
  } finally {
    await page.close();
    for (const gateway of gateways) await gateway.disconnect();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("verified same-account Bots merge on a real Hub, preserve timeout/cooldown on refresh, and show model-specific single-pool headings", async ({ page }) => {
  const f = await fixture(page);
  const responseBodies: string[] = [];
  page.on("response", async response => {
    if (response.url().includes("/api/engine-quotas")) {
      try { responseBodies.push(await response.text()); } catch { /* ignore */ }
    }
  });
  try {
    const now = Date.now();
    // Same verified account across two Codex Bots with distinct per-Bot revisions
    f.records.coder!.account = { accountId: "acct_shared_secret", userId: "user_shared_secret" };
    f.records.reviewer!.account = { accountId: "acct_shared_secret", userId: "user_shared_secret" };
    f.records.coder!.snapshot.observedAt = new Date(now - 20_000).toISOString();
    f.records.reviewer!.snapshot.observedAt = new Date(now - 5_000).toISOString();
    const reviewerWin = f.records.reviewer!.snapshot.pools[0]!.windows[0]!;
    if (reviewerWin.metric === "percent") reviewerWin.usedPercent = 20;

    // Model-specific single pool on Claude (e.g. Fable after claudeQuotaForModel strips models)
    f.records.writer!.snapshot = {
      authMode: "subscription",
      capability: { mode: "active" },
      state: "ready",
      availability: "allowed",
      observedAt: new Date(now).toISOString(),
      pools: [{
        id: "claude-fable",
        label: "Fable",
        sharing: "shared",
        availability: "allowed",
        windows: [{
          id: "seven_day",
          label: "7 days",
          metric: "percent",
          usedPercent: 30,
          availability: "allowed",
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          resetsAt: new Date(now + 3 * 86_400_000 + 20 * 3_600_000).toISOString(),
          periodSeconds: 604_800,
        }],
        balances: [],
        constraints: [],
      }],
      constraints: [],
    };

    await f.open();
    const panel = page.locator(".engine-quota:visible");
    const merged = panel.getByRole("region", { name: "Codex · Coding Bot, Review Bot", exact: true });
    await expect(merged).toBeVisible();
    await expect(merged.locator(".quota-account-badge")).toHaveText("2 个 Bot 共用同一账号");
    await expect(merged.locator(".quota-bot-chip")).toHaveText(["Coding Bot", "Review Bot"]);
    await expect(merged.locator(".quota-separate-note")).toHaveCount(0);
    // Selects fresher peer (Review Bot: 20% used -> 80% remaining)
    await expect(merged).toContainText("剩余 80%");

    // Distinct single-pool heading ("Fable") is shown, and 3d 20h countdown includes remaining hours
    const writer = panel.getByRole("region", { name: "Writing Bot · Claude Code", exact: true });
    await expect(writer.locator(".quota-pool h5")).toHaveText("Fable");
    await expect(writer).toContainText("3 天 20 小时后重置");

    // Refreshing the merged card when it times out keeps the fresher timeout + cooldown and never reverts to older peer (62%)
    f.records.reviewer!.onRefresh = () => {
      f.records.reviewer!.snapshot = {
        ...f.records.reviewer!.snapshot,
        state: "stale",
        reason: "timeout",
        lastAttemptAt: new Date(Date.now() + 1_000).toISOString(),
      };
    };
    await merged.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(merged.locator(".quota-state")).toHaveText("待更新");
    await expect(merged).toContainText("读取原生额度超时");
    await expect(merged).toContainText("上次读数：剩余 80%");
    await expect(merged).not.toContainText("剩余 62%");
    await expect(merged.getByRole("button", { name: "刷新", exact: true })).toBeDisabled();
    await expect(merged).toContainText("后可再刷新");

    // No raw account identifiers or proofs ever enter client HTTP responses
    expect(responseBodies.length).toBeGreaterThan(0);
    expect(responseBodies.join("\n")).not.toMatch(/acct_shared_secret|user_shared_secret|accountKey|proof/);
  } finally { await f.close(); }
});

test("offline Bot with cached reading keeps Refresh disabled and cached cards appear on cold offline reload (#137)", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open();
    const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%");
    // Now the Coding Bot goes offline (Hub returns offline fallback revision="offline"): cached bars remain marked old,
    // offline reason stays visible, and Refresh button MUST stay absent (never submit revision="offline").
    const directoryRead = (url: URL) => url.pathname === "/api/engine-quotas";
    await page.route(directoryRead, async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.scopes = body.scopes.map((scope: Record<string, unknown>) =>
        scope.id === "coder"
          ? { ...scope, state: "offline", reason: "offline", revision: "offline", observedAt: undefined, pools: [], constraints: [] }
          : scope,
      );
      await route.fulfill({ response, json: body });
    });
    await panel.getByRole("button", { name: "重新读取列表", exact: true }).click();
    await expect(coder).toContainText("Bot 当前离线");
    await expect(coder).toContainText("上次读数：剩余 62%");
    await expect(coder.locator(".quota-state")).toContainText("旧读数");
    await expect(coder.getByRole("button", { name: "刷新", exact: true })).toHaveCount(0);
    await page.unroute(directoryRead);

    // Cold reload while WebSocket cannot connect: Settings → Model quotas shows saved cards immediately beneath offline notice.
    await page.routeWebSocket("**/ws", socket => { socket.close(); });
    await page.reload();
    await f.open();
    await expect(page.locator(".engine-quota:visible")).toContainText("连接已断开，仅保留上次读数");
    await expect(page.locator(".engine-quota:visible").getByRole("region", { name: "Coding Bot · Codex", exact: true })).toContainText("上次读数：剩余 62%");
    await expect(page.locator(".engine-quota:visible").getByRole("region", { name: "Coding Bot · Codex", exact: true }).locator(".quota-state")).toContainText("旧读数");
  } finally { await f.close(); }
});
