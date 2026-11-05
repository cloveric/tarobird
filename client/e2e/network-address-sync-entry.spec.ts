import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

async function fixture(page: Page) {
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/network-manager.tsx"></script></body></html>';
  const vite = await createServer({ optimizeDeps: { entries: ["e2e/fixtures/network-manager.tsx"] }, plugins: [{ name: "sync-entry-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__sync-entry") return next(); response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml("/__sync-entry", html)); }); } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await vite.listen(); await page.goto(vite.resolvedUrls!.local[0]! + "__sync-entry"); return vite;
}
const overview = (page: Page) => page.getByRole("dialog", { name: "设备与网络", exact: true });
const shortcut = (page: Page) => overview(page).locator(".network-sync-shortcut > button").first();
const review = (page: Page) => page.getByRole("dialog", { name: "同步主机地址", exact: true });
const calls = (page: Page) => page.evaluate(() => (window as any).networkFixture.calls);

for (const width of [1360, 320]) test(`overview sync is discoverable, read-only until confirmation and targets the chosen host (${width})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { const f = (window as any).networkFixture; f.overview(["Mac mini", "工作站"]); f.deviceApproval(true); f.multipleRoutes(1); });
    await expect(shortcut(page)).toBeInViewport();
    await overview(page).screenshot({ path: info.outputPath(`sync-home-${width}.png`) });
    const help = overview(page).getByRole("button", { name: "了解同步主机地址", exact: true });
    await help.click();
    await page.getByRole("dialog", { name: "同步主机地址有什么用？", exact: true }).getByRole("button", { name: "知道了" }).click();
    await expect(help).toBeFocused();
    await shortcut(page).click();
    const select = review(page).getByRole("combobox", { name: "要同步的主机" });
    await expect(select).toHaveValue("");
    await expect(review(page).getByRole("button", { name: "确认同步" })).toHaveCount(0);
    await select.selectOption({ index: 2 });
    await expect(review(page).getByRole("heading", { name: "工作站", exact: true })).toBeVisible();
    await expect(review(page).locator(".network-route-list").last()).toContainText("https://100.80.1.20:8788");
    await expect(review(page).locator(".network-route-list").last()).not.toContainText("host-a.test");
    await expect(review(page).locator(".network-sync-replacement")).toContainText("https://host-b.test");
    expect(await calls(page)).toEqual([]);
    await review(page).screenshot({ path: info.outputPath(`sync-review-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(shortcut(page)).toBeFocused();
    await shortcut(page).click();
    await expect(select).toHaveValue("");
    await select.selectOption({ index: 2 });
    await review(page).getByRole("button", { name: "确认同步", exact: true }).click();
    await expect(review(page)).toHaveCount(0);
    expect(await calls(page)).toEqual([{ host: 1, command: { operation: "routes", networkId: "network-fixture", routes: [{ name: "Tailscale", url: "https://100.80.1.20:8788" }, { name: "VPS", url: "https://relay.example" }] } }]);
    await expect(shortcut(page)).toBeFocused();
    await expect(overview(page).getByRole("status")).toContainText("工作站");
  } finally { await page.close(); await vite.close(); }
});

test("a single host opens its address review directly, without publishing", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.singleton());
    await shortcut(page).click();
    await expect(review(page).getByRole("combobox")).not.toHaveValue("");
    await expect(review(page).locator(".network-route-list")).toHaveText(["https://host-a.test"]);
    expect(await calls(page)).toEqual([]);
    await review(page).getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(shortcut(page)).toBeFocused();
  } finally { await page.close(); await vite.close(); }
});

test("a pending member prevents implicit host selection and points to the join flow", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.singleton("active"));
    await shortcut(page).click();
    await expect(review(page).getByRole("combobox")).toHaveValue("");
    await expect(review(page)).toContainText("待加入主机的地址请在「继续加入」中设置。");
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

test("waiting receipt is shown honestly and read-only refresh clears it without publishing", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { const f = (window as any).networkFixture; f.overview(); f.routesWaiting(1); });
    await shortcut(page).click();
    await review(page).getByRole("combobox").selectOption({ index: 2 });
    await review(page).getByRole("button", { name: "确认同步", exact: true }).click();
    await expect(review(page)).toHaveCount(0);
    await expect(overview(page).getByRole("status")).toContainText("正在等待协调主机同步");
    await expect(shortcut(page)).toBeFocused();
    await overview(page).getByRole("button", { name: "刷新网络", exact: true }).click();
    await expect(overview(page).getByText(/正在等待协调主机同步/)).toHaveCount(0);
    expect(await calls(page)).toHaveLength(1);
  } finally { await page.close(); await vite.close(); }
});

for (const state of ["offline", "member", "old"] as const) test(`selected host ${state} explains why synchronization is disabled`, async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    await shortcut(page).click();
    await review(page).getByRole("combobox").selectOption({ index: 1 });
    await page.evaluate(state => {
      const f = (window as any).networkFixture;
      if (state === "offline") f.offlineAuthority(); else f.authorityAccess(state === "member" ? "member" : "owner", state !== "old");
    }, state);
    await expect(review(page).getByRole("button", { name: "确认同步", exact: true })).toBeDisabled();
    await expect(review(page).getByRole("status")).toContainText(state === "offline" ? "离线" : state === "member" ? "管理权限，不能同步地址" : "需要更新后才能同步地址");
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

test("membership changes cannot silently retarget the overview publication", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    await shortcut(page).click();
    await review(page).getByRole("combobox").selectOption({ index: 2 });
    await page.evaluate(() => (window as any).networkFixture.ownMultiHostNetwork());
    await expect(review(page).getByRole("alert")).toContainText("网络归属已变化");
    await expect(review(page).getByRole("button", { name: "确认同步" })).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

test("unknown members stay selectable with a connection explanation instead of choosing a different host", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await shortcut(page).click();
    await review(page).getByRole("combobox").selectOption({ index: 2 });
    await expect(review(page).getByRole("status")).toHaveText("此设备尚未连接这台主机。");
    await expect(review(page).getByRole("button", { name: "确认同步" })).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

test("publication errors preserve the target and pending publication cannot be submitted twice", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { const f = (window as any).networkFixture; f.overview(); f.failRoutes(1, "network_identity_mismatch"); });
    await shortcut(page).click();
    const select = review(page).getByRole("combobox");
    await select.selectOption({ index: 2 });
    const selected = await select.inputValue();
    const confirm = review(page).getByRole("button", { name: "确认同步", exact: true });
    await confirm.click();
    await expect(review(page).getByRole("alert")).toHaveText("网络信息又有变化，请返回重新查看后确认。");
    await expect(select).toHaveValue(selected);
    await page.evaluate(() => { const f = (window as any).networkFixture; f.failRoutes(1, ""); f.holdCommand("routes"); });
    await confirm.click();
    await expect(confirm).toBeDisabled(); await expect(select).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(review(page)).toBeVisible();
    expect(await calls(page)).toHaveLength(2);
    await page.evaluate(() => (window as any).networkFixture.releaseCommand());
    await expect(review(page)).toHaveCount(0);
    expect(await calls(page)).toHaveLength(2);
  } finally { await page.close(); await vite.close(); }
});

test("missing routes lead to the chosen host connection settings and return to the same selection", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { const f = (window as any).networkFixture; f.overview(); f.noShareableRoutes(1); });
    await shortcut(page).click();
    const select = review(page).getByRole("combobox");
    await select.selectOption({ index: 2 });
    const selected = await select.inputValue();
    await review(page).getByRole("button", { name: /^连接状态与线路/ }).click();
    const settings = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
    await expect(settings).toContainText("当前主机：示例电脑");
    await settings.getByRole("button", { name: "返回地址同步", exact: true }).click();
    await expect(select).toHaveValue(selected);
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

for (const joining of [false, true]) test(`existing ${joining ? "join" : "detail"} entry does not leak an overview success receipt`, async ({ page }) => {
  const vite = await fixture(page);
  try {
    if (joining) {
      await page.evaluate(() => (window as any).networkFixture.requireRouteReview(1));
      await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
      await page.getByRole("dialog", { name: "加入网络", exact: true }).getByRole("button", { name: "准备「同名主机」的连接线路", exact: true }).click();
    } else {
      await page.evaluate(() => (window as any).networkFixture.overview());
      await overview(page).locator(".network-member").nth(1).click();
      await page.getByRole("dialog", { name: "示例电脑", exact: true }).getByRole("button", { name: "同步主机地址", exact: true }).click();
    }
    await review(page).getByRole("button", { name: "确认同步", exact: true }).click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: joining ? "加入网络" : "示例电脑", exact: true })).toBeVisible();
    await expect(overview(page).locator(".settings-feedback")).toHaveCount(0);
    expect(await calls(page)).toHaveLength(1);
  } finally { await page.close(); await vite.close(); }
});

test("sync shortcut only appears for a network and stays within the selected network", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.ownMultiHostNetwork());
    await overview(page).getByRole("combobox", { name: "网络", exact: true }).selectOption({ index: 1 });
    await shortcut(page).click();
    await expect(review(page).getByRole("combobox").locator("option")).toHaveCount(3);
    await review(page).getByRole("combobox").selectOption({ index: 1 });
    await expect(review(page).locator(".network-route-list")).toHaveText(["https://host-b.test"]);
    await review(page).getByRole("button", { name: "取消", exact: true }).click();
    await page.evaluate(() => (window as any).networkFixture.standaloneAll());
    await expect(shortcut(page)).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

test("narrow English dark view wraps the shortcut and address review without overflow", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const vite = await fixture(page);
  try {
    await page.evaluate(async () => {
      // @ts-expect-error Vite serves the runtime module in this isolated fixture.
      const { setLocale } = await import("/src/i18n.ts"); setLocale("en");
      document.documentElement.dataset.theme = "dark";
      (window as any).networkFixture.overview(["Studio desktop with a long host name", "Remote workstation"]);
      (window as any).networkFixture.multipleRoutes(0);
    });
    const sheet = page.getByRole("dialog", { name: "Devices & network", exact: true });
    const button = sheet.locator(".network-sync-shortcut > button").first();
    await expect(button).toBeInViewport();
    expect(await sheet.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await sheet.screenshot({ path: info.outputPath("sync-home-english-dark.png") });
    await button.click();
    const sync = page.getByRole("dialog", { name: "Sync host addresses", exact: true });
    await sync.getByRole("combobox").selectOption({ index: 1 });
    expect(await sync.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await sync.screenshot({ path: info.outputPath("sync-review-english-dark.png") });
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});
