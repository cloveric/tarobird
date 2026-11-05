import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";
import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/network-manager.tsx"></script></body></html>';
const overview = (page: Page) => page.getByRole("dialog", { name: "设备与网络", exact: true });
async function fixture(page: Page) {
  const vite = await createServer({ optimizeDeps: { entries: ["e2e/fixtures/network-manager.tsx"] }, plugins: [{ name: "network-manager-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__network-manager") return next(); response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml("/__network-manager", html)); }); } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await vite.listen(); await page.goto(vite.resolvedUrls!.local[0]! + "__network-manager"); return vite;
}
const inspectCalls = (page: Page) => page.evaluate(() => (window as unknown as { networkFixture: { calls: Array<{ host: number; command: { operation: string } }> } }).networkFixture.calls);

test("online coordinator without administration rights is not reported unavailable", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.authorityAccess("member"));
    await expect(overview(page).locator(".network-member").first()).toContainText("已连接");
    await expect(overview(page)).not.toContainText("协调主机当前不可用");
    await expect(overview(page)).toContainText("没有网络管理权限");
    await expect(overview(page).getByRole("button", { name: "加入网络", exact: true })).toBeDisabled();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("a slow read-only refresh keeps focus and allows the sheet to close", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.holdRefresh());
    const refresh = overview(page).getByRole("button", { name: "刷新网络", exact: true });
    await refresh.focus(); await page.keyboard.press("Enter");
    await expect(overview(page).getByRole("button", { name: "关闭设备与网络", exact: true })).toBeEnabled();
    await expect(overview(page).locator('[aria-busy="true"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(overview(page)).toHaveCount(0);
    await page.evaluate(() => { (window as any).networkFixture.refreshFailure(0, "late_failure"); (window as any).networkFixture.releaseRefresh(); });
    await page.getByRole("button", { name: "打开网络", exact: true }).click();
    await expect(overview(page).getByRole("alert")).toHaveCount(0);
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("network notices distinguish unsupported hosts, connecting, and offline state", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.authorityAccess("owner", false));
    await expect(overview(page)).toContainText("尚不支持网络管理");
    await expect(overview(page).locator(".network-member").first()).toContainText("已连接");
    await page.evaluate(() => (window as any).networkFixture.authorityStatus("connecting"));
    await expect(overview(page).locator(".network-member-status").first()).toHaveText("连接中…");
    await expect(overview(page).locator(".network-availability")).toContainText("正在连接");
    await page.evaluate(() => (window as any).networkFixture.offlineAuthority());
    await expect(overview(page).locator(".network-member-status").first()).toHaveText("离线");
    await expect(overview(page).locator(".network-availability")).toContainText("已配对设备仍可使用其他在线主机");
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("automatic admission uses the same capability and connection guidance as overview", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.evaluate(() => (window as any).networkFixture.authorityAccess("owner", false));
    await page.getByRole("button", { name: "继续配对后加入", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await expect(join).toContainText("尚不支持网络管理");
    await expect(join).not.toContainText("没有网络管理权限");
    await page.evaluate(() => (window as any).networkFixture.authorityStatus("connecting"));
    await expect(join).toContainText("正在连接「同名主机」");
    await expect(join).not.toContainText("离线");
    await page.evaluate(() => { (window as any).networkFixture.authorityStatus("online"); (window as any).networkFixture.authorityAccess("member"); });
    await expect(join).toContainText("没有网络管理权限");
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeDisabled();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("a completed operation clears a previous refresh error", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.refreshFailure(0, "模拟刷新失败"));
    await overview(page).getByRole("button", { name: "刷新网络", exact: true }).click();
    await expect(overview(page).getByRole("alert")).toHaveText("模拟刷新失败");
    await page.evaluate(() => (window as any).networkFixture.refreshFailure(0, ""));
    await overview(page).locator(".network-member").first().click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await detail.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await detail.getByLabel("主机名称", { exact: true }).fill("新名称");
    await detail.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByRole("dialog", { name: "新名称", exact: true }).getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(overview(page).getByRole("alert")).toHaveCount(0);
    await expect(overview(page).locator(".network-member").first()).toContainText("新名称");
  } finally { await page.close(); await vite.close(); }
});

for (const width of [320, 390, 1360]) test(`network overview stays compact and accessible at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    const sheet = overview(page), members = sheet.locator(".network-member");
    await expect(sheet.getByRole("heading", { name: "设备与网络", exact: true })).toHaveCount(1);
    await expect(sheet.getByRole("heading", { name: "已加入的主机", exact: true })).toBeVisible();
    await expect(sheet.locator(".network-member-status.is-online")).toHaveCount(2);
    await expect(members.locator("small")).toHaveCount(0);
    await expect(sheet.locator(".network-help > div")).not.toBeVisible();
    await expectOneDisclosure(sheet.locator(".network-help > summary"));
    await sheet.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
    expect((await sheet.boundingBox())!.height).toBeLessThanOrEqual(820);
    for (const node of [sheet, ...await members.all(), sheet.getByRole("button", { name: "此设备的连接", exact: true })]) {
      const box = (await node.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    for (const target of await sheet.locator("button, summary").all()) {
      const box = (await target.boundingBox())!;
      expect(box.height, await target.evaluate(node => node.outerHTML.slice(0, 160))).toBeGreaterThanOrEqual(width < 761 ? 44 : 32);
    }
    await sheet.screenshot({ path: info.outputPath(`network-${width}-light.png`) });
    if (width === 390) {
      await page.evaluate(() => document.documentElement.dataset.theme = "dark");
      await sheet.screenshot({ path: info.outputPath("network-390-dark.png") });
      await page.evaluate(() => document.documentElement.dataset.theme = "light");
    }
    const help = sheet.locator("summary");
    await help.focus(); await page.keyboard.press("Enter");
    await expect(sheet.locator(".network-help > div")).toBeVisible();
    await expect(sheet.locator(".network-help")).toContainText("「example-mac」是协调主机");
    if (width === 390) await sheet.screenshot({ path: info.outputPath("network-help-phone.png") });
    expect(await inspectCalls(page)).toHaveLength(0);
    // WebKit does not focus buttons on pointer clicks. Exercise keyboard
    // activation so the return-focus contract is the same in both engines.
    await members.first().focus(); await page.keyboard.press("Enter");
    const detail = page.getByRole("dialog", { name: "example-mac", exact: true });
    await expect(detail).toContainText("公钥尾号");
    await expect(detail).toContainText("日常对话无需通过它转发");
    await detail.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(members.first()).toBeFocused();
    await sheet.getByRole("button", { name: "此设备的连接", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText("连接设置入口", { exact: true })).toBeVisible();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("duplicate names keep identity suffixes and long English content fits landscape", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview(["同名主机", "同名主机"]));
    await expect(overview(page).locator(".network-member small")).toHaveCount(2);
    expect(new Set(await overview(page).locator(".network-member small").allTextContents()).size).toBe(2);
    await page.evaluate(async () => {
      const { setLocale } = await import("/src/i18n.ts"); setLocale("en");
      (window as any).networkFixture.overview(["Long host name ".repeat(6), "Another host"], "My network");
      (window as any).networkFixture.authorityAccess("member");
    });
    const sheet = page.getByRole("dialog", { name: "Devices & network", exact: true });
    await expect(sheet).toContainText("This device cannot manage the network");
    await expect(sheet.locator(".network-member-status.is-online")).toHaveCount(2);
    await sheet.locator("summary").click();
    for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      expect(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const connections = sheet.getByRole("button", { name: "Connections on this device", exact: true });
      await connections.scrollIntoViewIfNeeded();
      const box = (await connections.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    }
    await sheet.screenshot({ path: info.outputPath("network-landscape-english.png") });
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

for (const missingHost of [0, 1]) test(`join footer guides route sharing before consent (host ${missingHost})`, async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(index => (window as any).networkFixture.requireRouteReview(index), missingHost);
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await expect(join.getByRole("checkbox")).toBeDisabled();
    const next = join.getByRole("button", { name: "准备「同名主机」的连接线路", exact: true });
    await expect(next).toBeEnabled();
    expect(await inspectCalls(page)).toHaveLength(0);
    await next.click();
    const routes = page.getByRole("dialog", { name: "同步主机地址", exact: true });
    await expect(routes).toContainText(`https://host-${missingHost ? "b" : "a"}.test`);
    expect(await inspectCalls(page)).toHaveLength(0);
    await routes.getByRole("button", { name: "确认同步", exact: true }).click();
    await expect(routes).toHaveCount(0);
    await expect(join.getByRole("checkbox")).toBeEnabled();
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeDisabled();
    expect((await inspectCalls(page)).map(call => [call.host, call.command.operation])).toEqual([[missingHost, "routes"]]);
    await join.getByRole("checkbox").check();
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeEnabled();
  } finally { await page.close(); await vite.close(); }
});

for (const locale of ["zh", "en"] as const) test(`post-pairing creation bounds the default name of a full-length host (${locale})`, async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.evaluate(async language => {
      (window as any).networkFixture.standaloneTarget("机".repeat(100));
      const { setLocale } = await import("/src/i18n.ts"); setLocale(language);
    }, locale);
    await page.getByRole("button", { name: "继续配对后加入", exact: true }).click();
    await page.locator(".network-onboarding-note").getByRole("button").click();
    const create = page.getByRole("dialog", { name: locale === "en" ? "Create network" : "创建网络", exact: true });
    const name = locale === "en" ? "My network" : "我的网络";
    await expect(create.getByLabel(locale === "en" ? "Network name" : "网络名称", { exact: true })).toHaveValue(name);
    await create.getByRole("button", { name: locale === "en" ? "Create network" : "创建网络", exact: true }).click();
    await expect(create).toHaveCount(0);
    expect(await inspectCalls(page)).toEqual([{ host: 0, command: { operation: "create", name } }]);
  } finally { await page.close(); await vite.close(); }
});

test("a rejected departure retains its state-change reason when directory refresh also fails", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.pendingSource());
    await overview(page).locator(".network-member").filter({ hasText: "待完成加入" }).click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await detail.getByRole("button", { name: "取消加入", exact: true }).click();
    const cancel = page.getByRole("dialog", { name: "取消「同名主机」的加入申请？", exact: true });
    await page.evaluate(() => {
      (window as any).networkFixture.completePending();
      (window as any).networkFixture.refreshFailure(0, "network_membership_changed");
    });
    await cancel.getByRole("button", { name: "取消加入", exact: true }).click();
    await expect(cancel).toHaveCount(0);
    await expect(detail.getByRole("alert")).toContainText("主机加入状态已变化");
    await expect(detail.getByRole("button", { name: "退出网络", exact: true })).toBeEnabled();
    expect((await inspectCalls(page)).map(call => call.command)).toEqual([expect.objectContaining({ operation: "leave", expectedState: "pending" })]);
  } finally { await page.close(); await vite.close(); }
});

test("a rejected join retains its review reason through refresh failure and requires renewed consent", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await join.getByRole("checkbox").check();
    await page.evaluate(() => {
      (window as any).networkFixture.changeDirectory();
      (window as any).networkFixture.refreshFailure(0, "network_membership_changed");
    });
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join.getByRole("alert")).toContainText("网络成员已变化");
    await expect(join.getByRole("checkbox")).not.toBeChecked();
    await expect(join.getByRole("button", { name: "重试加入", exact: true })).toBeDisabled();
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["propose", "admit"]);
    // Once reads recover, the rejected proposal still cannot become consent
    // for a different directory. Reread it and require a separate confirmation.
    await page.evaluate(() => (window as any).networkFixture.refreshFailure(0, ""));
    await join.getByRole("checkbox").check();
    await join.getByRole("button", { name: "重试加入", exact: true }).click();
    await expect(join.getByRole("checkbox")).not.toBeChecked();
    await join.locator("summary").click();
    await expect(join).toContainText("刚加入的另一台主机");
    await join.getByRole("checkbox").check();
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join).toHaveCount(0);
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["propose", "admit", "admit", "propose", "admit", "join"]);
  } finally { await page.close(); await vite.close(); }
});

test("sharing routes cannot look cancelled while the host is still committing them", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).locator(".network-member").first().click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await detail.getByRole("button", { name: "同步主机地址", exact: true }).click();
    const routes = page.getByRole("dialog", { name: "同步主机地址", exact: true });
    await page.evaluate(() => (window as any).networkFixture.holdCommand("routes"));
    await routes.getByRole("button", { name: "确认同步", exact: true }).click();
    await expect.poll(() => inspectCalls(page)).toHaveLength(1);
    await expect(routes.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(routes).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.releaseCommand());
    await expect(routes).toHaveCount(0);
    await expect(detail).toBeVisible();
    expect(await inspectCalls(page)).toHaveLength(1);
  } finally { await page.close(); await vite.close(); }
});

test("only the local desktop offers singleton dissolution and confirms lost device access", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.singleton());
    await overview(page).locator(".network-member").first().click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await expect(detail).toContainText("请在「同名主机」电脑的桌面版中解散网络");
    await expect(detail).toContainText("tarobot network leave --yes");
    await expect(detail.getByRole("button", { name: "解散网络", exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).networkFixture.localController(true));
    await detail.getByRole("button", { name: "解散网络", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "解散「工作网络」？", exact: true });
    await expect(confirm).toContainText("本机桌面端可继续使用");
    await expect(confirm).toContainText("访问授权将撤销，再次连接需要重新扫码配对");
    expect(await inspectCalls(page)).toHaveLength(0);
    await confirm.getByRole("button", { name: "返回", exact: true }).last().click();
    expect(await inspectCalls(page)).toHaveLength(0);
    await detail.getByRole("button", { name: "解散网络", exact: true }).click();
    await confirm.getByRole("button", { name: "解散网络", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(await inspectCalls(page)).toEqual([{ host: 0, command: { operation: "leave", networkId: "network-fixture", expectedState: "active" } }]);
    await expect(overview(page).getByRole("button", { name: "创建网络", exact: true })).toBeVisible();
  } finally { await page.close(); await vite.close(); }
});

test("pending members block dissolution; expired invitations do not; a late member change cancels confirmation", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => { (window as any).networkFixture.singleton("active"); (window as any).networkFixture.localController(true); });
    await overview(page).locator(".network-member").first().click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await expect(detail).toContainText("协调主机不能直接退出仍有其他成员的网络");
    await expect(detail.getByRole("button", { name: "解散网络", exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).networkFixture.singleton("expired"));
    await detail.getByRole("button", { name: "解散网络", exact: true }).click();
    await page.evaluate(() => (window as any).networkFixture.changeDirectory());
    const confirm = page.getByRole("dialog", { name: "解散「工作网络」？", exact: true });
    await confirm.getByRole("button", { name: "解散网络", exact: true }).click();
    await expect(confirm.getByRole("alert")).toContainText("网络成员已变化");
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("network membership requires consent, preserves staged retry, and retains offline members", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const vite = await fixture(page);
  try {
    await expect(overview(page).locator(".network-member")).toHaveCount(2);
    await expect(overview(page).getByRole("button", { name: /尚未连接的工作主机/ })).toContainText("未连接");
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeDisabled();
    expect(await inspectCalls(page)).toHaveLength(0);
    await join.getByRole("checkbox").check();
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join.getByRole("alert")).toHaveText("模拟连接中断");
    await expect(join.getByRole("status")).toContainText("已保存加入批准");
    // Back remains usable after a partial success; returning to the same join
    // retains its signed admission instead of asking the authority twice.
    await join.getByRole("button", { name: "返回", exact: true }).click();
    await expect(overview(page).locator(".network-member").filter({ hasText: "待完成加入" })).toHaveCount(1);
    await expect(overview(page).locator(".network-summary-meta")).toContainText("1 台待加入");
    await expect(overview(page).locator(".network-member-status.is-online")).toHaveCount(1);
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.getByRole("button", { name: "打开网络", exact: true }).click();
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    await join.getByRole("checkbox").check();
    await join.getByRole("button", { name: "重试加入", exact: true }).click();
    await expect(join).toHaveCount(0);
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["propose", "admit", "join", "join"]);
    await expect(overview(page).locator(".network-member")).toHaveCount(3);
    await page.evaluate(() => (window as any).networkFixture.offlineAuthority());
    await expect(overview(page)).toContainText("已配对设备仍可使用其他在线主机");
    await expect(overview(page).locator(".network-member-status.is-online")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(overview(page)).toHaveCSS("outline-style", "none");
    await page.screenshot({ path: info.outputPath("network-phone.png") });
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await expect(overview(page)).toHaveCount(0);
  } finally { await page.close(); await vite.close(); }
});

test("routes are published only after their own review and confirmation", async ({ page }, info) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.requireRouteReview());
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await expect(join.getByRole("checkbox")).toBeDisabled();
    await expect(join).toContainText("还差一步");
    await join.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
    await join.screenshot({ path: info.outputPath("network-join.png") });
    await expect(join.getByRole("button", { name: "准备「同名主机」的连接线路", exact: true })).toBeEnabled();
    expect(await inspectCalls(page)).toHaveLength(0);
    await join.locator(".network-join-route").filter({ hasText: "尚未共享线路" }).getByRole("button", { name: "检查或同步地址", exact: true }).click();
    const routes = page.getByRole("dialog", { name: "同步主机地址", exact: true });
    await expect(routes).toContainText("https://host-b.test");
    expect(await inspectCalls(page)).toHaveLength(0);
    await routes.getByRole("button", { name: "确认同步", exact: true }).click();
    await expect(routes).toHaveCount(0);
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["routes"]);
    await join.getByRole("checkbox").check();
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeEnabled();
    await join.getByRole("button", { name: "返回", exact: true }).click();
  } finally { await page.close(); await vite.close(); }
});

test("shared host rename handles a concurrent edit and network removal requires confirmation", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).locator(".network-member").first().click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await detail.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await detail.getByLabel("主机名称", { exact: true }).fill("正在编辑的主机名称");
    await page.evaluate(() => (window as any).networkFixture.renameElsewhere());
    const renamed = page.getByRole("dialog", { name: "其他设备的新名称", exact: true });
    await renamed.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(renamed.getByRole("alert")).toContainText("其他设备修改");
    await expect(renamed.getByLabel("主机名称", { exact: true })).toHaveValue("正在编辑的主机名称");
    await renamed.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await renamed.getByLabel("主机名称", { exact: true }).fill("Mac mini 工作主机");
    await renamed.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByRole("dialog", { name: "Mac mini 工作主机", exact: true }).getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await overview(page).getByRole("button", { name: /尚未连接的工作主机/ }).click();
    await page.getByRole("dialog", { name: "尚未连接的工作主机", exact: true }).getByRole("button", { name: "移出网络", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "将「尚未连接的工作主机」移出网络？", exact: true });
    await expect(remove).toContainText("主机上的 Bot、对话和文件保留");
    await expect(remove).toContainText("手机和其他网络设备留在原网络，不能再访问这台主机");
    await expect(remove).toContainText("需要重新扫码配对");
    await expect(remove).not.toContainText("单独配对授权需要");
    await expect(remove).toContainText("此网络不再接受该主机身份");
    expect(await inspectCalls(page)).toHaveLength(0);
    await page.evaluate(() => (window as any).networkFixture.failRefreshAfterDeparture());
    await remove.getByRole("button", { name: "移出网络", exact: true }).click();
    await expect(overview(page).locator(".network-member")).toHaveCount(1);
    expect(await page.evaluate(() => document.activeElement?.closest("dialog")?.getAttribute("aria-label"))).toBe("设备与网络");
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["remove"]);
    await expect(overview(page).getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); await vite.close(); }
});

test("a changed directory invalidates consent and requires a fresh explicit review", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await join.getByRole("checkbox").check();
    await page.evaluate(() => (window as any).networkFixture.changeDirectory());
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join.getByRole("alert")).toContainText("网络成员已变化");
    await expect(join.getByRole("checkbox")).not.toBeChecked();
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeDisabled();
    await join.locator("summary").click();
    await expect(join).toContainText("刚加入的另一台主机");
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["propose", "admit"]);
    await join.getByRole("checkbox").check();
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join).toHaveCount(0);
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["propose", "admit", "propose", "admit", "join"]);
  } finally { await page.close(); await vite.close(); }
});


test("canceling a pending join cannot silently remove a host that becomes active", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.pendingSource());
    await overview(page).locator(".network-member").filter({ hasText: "待完成加入" }).click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await expect(detail.getByRole("button", { name: "移出网络", exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "取消加入", exact: true }).click();
    const cancel = page.getByRole("dialog", { name: "取消「同名主机」的加入申请？", exact: true });
    await expect(cancel).toContainText("取消后可以重新申请加入");
    await page.evaluate(() => (window as any).networkFixture.completePending());
    await cancel.getByRole("button", { name: "取消加入", exact: true }).click();
    await expect(cancel).toHaveCount(0);
    await expect(detail.getByRole("alert")).toContainText("主机加入状态已变化");
    expect((await inspectCalls(page)).map(call => call.command)).toEqual([expect.objectContaining({ operation: "leave", expectedState: "pending" })]);
    await expect(detail.getByRole("button", { name: "移出网络", exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "退出网络", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "让「同名主机」退出网络？", exact: true });
    await expect(leave).toContainText("再次加入需要新的主机身份");
    await leave.getByRole("button", { name: "返回", exact: true }).last().click();
    expect(await inspectCalls(page)).toHaveLength(1);
  } finally { await page.close(); await vite.close(); }
});

test("a pending member can cancel locally without issuing an authority removal", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.pendingSource());
    await overview(page).locator(".network-member").filter({ hasText: "待完成加入" }).click();
    await page.getByRole("dialog", { name: "同名主机", exact: true }).getByRole("button", { name: "取消加入", exact: true }).click();
    await page.getByRole("dialog", { name: "取消「同名主机」的加入申请？", exact: true }).getByRole("button", { name: "取消加入", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "取消「同名主机」的加入申请？", exact: true })).toHaveCount(0);
    await expect(overview(page).getByRole("button", { name: "加入网络", exact: true })).toBeEnabled();
    expect((await inspectCalls(page)).map(call => call.command)).toEqual([expect.objectContaining({ operation: "leave", expectedState: "pending" })]);
  } finally { await page.close(); await vite.close(); }
});

test("network changes require a reviewed confirmation and a changed review cannot be silently accepted", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.newNetwork());
    await overview(page).getByRole("button", { name: "查看变更", exact: true }).click();
    const review = page.getByRole("dialog", { name: "查看网络变更", exact: true });
    await expect(review).toContainText("新的工作网络");
    await expect(review.getByRole("button", { name: "确认变更", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).networkFixture.confirmedChanges())).toHaveLength(0);
    await review.getByRole("checkbox").check();
    await page.evaluate(() => (window as any).networkFixture.changeReviewAgain());
    await review.getByRole("button", { name: "确认变更", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(overview(page).getByRole("alert")).toContainText("网络信息又有变化");
    await overview(page).getByRole("button", { name: "查看变更", exact: true }).click();
    await expect(review).toContainText("再次变更的网络");
    await expect(review.getByRole("checkbox")).not.toBeChecked();
    await review.getByRole("checkbox").check();
    await review.getByRole("button", { name: "确认变更", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(overview(page).getByRole("button", { name: "查看变更", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).networkFixture.confirmedChanges())).toHaveLength(2);
  } finally { await page.close(); await vite.close(); }
});

test("local departure review explains that phones stay in their network and must pair again", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.leaveNetwork());
    await expect(overview(page)).toContainText("已退出网络");
    await overview(page).getByRole("button", { name: "查看变更", exact: true }).click();
    const review = page.getByRole("dialog", { name: "查看网络变更", exact: true });
    await expect(review).toContainText("手机继续留在原网络");
    await expect(review).toContainText("需要重新扫码配对");
    await expect(review).not.toContainText("保留单独配对");
    expect(await page.evaluate(() => (window as any).networkFixture.confirmedChanges())).toHaveLength(0);
    await review.getByRole("button", { name: "确认变更", exact: true }).click();
    await expect(review).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).networkFixture.confirmedChanges())).toHaveLength(1);
  } finally { await page.close(); await vite.close(); }
});

test("a successful join stays successful when another host cannot refresh", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.failRefreshAfterJoin());
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await join.getByRole("checkbox").check(); await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join).toHaveCount(0);
    await expect(overview(page).getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tarobot:network-join:v1:")))).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});

test("a lost admission response can resume the same signed proposal after closing the manager", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.dropAdmissionResponse());
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await join.getByRole("checkbox").check(); await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join.getByRole("alert")).toContainText("加入确认响应丢失");
    await join.getByRole("button", { name: "返回", exact: true }).click();
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.getByRole("button", { name: "打开网络", exact: true }).click();
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    await join.getByRole("checkbox").check(); await join.getByRole("button", { name: "重试加入", exact: true }).click();
    await expect(join).toHaveCount(0);
    expect((await inspectCalls(page)).map(call => call.command.operation)).toEqual(["propose", "admit", "admit", "join"]);
  } finally { await page.close(); await vite.close(); }
});

test("automatic join review explains an offline coordinator", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.offlineAuthority());
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.getByRole("button", { name: "继续配对后加入", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await expect(join).toContainText("「同名主机」暂时离线");
    await join.getByRole("checkbox").check();
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeDisabled();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("automatic join does not offer to merge a host that already coordinates another network", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.ownMultiHostNetwork());
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.getByRole("button", { name: "继续配对后加入", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "加入网络", exact: true })).toHaveCount(0);
    await expect(overview(page).getByRole("alert")).toContainText("已属于另一个网络");
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});


test("a resumed join opens after the local host reconnects without reopening the manager", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page)).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.sourceOnline(false));
    await overview(page).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.getByRole("button", { name: "继续配对后加入", exact: true }).click();
    await expect(overview(page).getByRole("alert")).toContainText("主机当前不可用");
    await expect(page.getByRole("dialog", { name: "加入网络", exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).networkFixture.sourceOnline(true));
    await expect(page.getByRole("dialog", { name: "加入网络", exact: true })).toBeVisible();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});
test("a confirmed shared rename closes the editor even when directory refresh fails", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await overview(page).locator(".network-member").first().click();
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await detail.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await detail.getByLabel("主机名称", { exact: true }).fill("example-mac");
    await page.evaluate(() => (window as any).networkFixture.failNameRefresh());
    await detail.getByRole("button", { name: "保存名称", exact: true }).click();
    const renamed = page.getByRole("dialog", { name: "example-mac", exact: true });
    await expect(renamed).toBeVisible();
    await expect(renamed.getByLabel("主机名称", { exact: true })).toHaveCount(0);
    await expect(renamed.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); await vite.close(); }
});

test("the summary names the network, its coordinator, counts and management state", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    const summary = overview(page).locator(".network-summary");
    await expect(summary.getByRole("heading", { name: "网络 我的网络", exact: true })).toBeVisible();
    await expect(summary.locator(".network-summary-meta")).toHaveText(/协调 example-mac.*2 台主机.*2 台在线/);
    await expect(summary.locator(".network-state")).toHaveText("正常");
    await expect(overview(page).locator(".network-member").first()).toContainText("协调");
    await page.evaluate(() => (window as any).networkFixture.authorityAccess("member"));
    await expect(summary.locator(".network-state")).toHaveText("仅可查看");
    await page.evaluate(() => (window as any).networkFixture.offlineAuthority());
    await expect(summary.locator(".network-state")).toHaveText("协调主机离线");
    await expect(summary.locator(".network-summary-meta")).toContainText("1 台在线");
    await page.evaluate(() => (window as any).networkFixture.localController(true));
    await expect(overview(page).locator(".network-member").first().locator(".network-tag")).toHaveText(["协调", "本机"]);
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("host connection settings open for that host and return to its detail with drafts intact", async ({ page }, info) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    await overview(page).locator(".network-member").nth(1).click();
    const detail = page.getByRole("dialog", { name: "示例电脑", exact: true });
    await detail.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await detail.getByLabel("主机名称", { exact: true }).fill("尚未保存的名称");
    const open = detail.getByRole("button", { name: /^连接状态与线路/ });
    await open.focus(); await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
    await expect(settings).toContainText("当前主机：示例电脑");
    await expect(settings).toContainText("https://host-b.test");
    await expect(settings).not.toContainText("https://host-a.test");
    await settings.screenshot({ path: info.outputPath("network-connection-settings.png") });
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(open).toBeFocused();
    await expect(detail.getByLabel("主机名称", { exact: true })).toHaveValue("尚未保存的名称");
    await open.click();
    await settings.getByRole("button", { name: "返回主机详情", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(detail.getByLabel("主机名称", { exact: true })).toHaveValue("尚未保存的名称");
    await expect(overview(page)).toBeVisible();
    await expect(page.getByText("连接设置入口", { exact: true })).toHaveCount(0);
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("a host without shareable routes opens its own connection settings from route sharing", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { (window as any).networkFixture.overview(); (window as any).networkFixture.noShareableRoutes(1); });
    await overview(page).locator(".network-member").nth(1).click();
    const detail = page.getByRole("dialog", { name: "示例电脑", exact: true });
    await expect(detail).toContainText("尚未共享线路");
    await detail.getByRole("button", { name: "同步主机地址", exact: true }).click();
    const routes = page.getByRole("dialog", { name: "同步主机地址", exact: true });
    await expect(routes).toContainText("尚未配置可共享的 HTTPS 线路");
    await routes.getByRole("button", { name: /^连接状态与线路/ }).click();
    const settings = page.getByRole("dialog", { name: "连接状态与线路", exact: true });
    await expect(settings).toContainText("当前主机：示例电脑");
    await settings.getByRole("button", { name: "返回地址同步", exact: true }).click();
    await expect(routes).toBeVisible();
    await expect(overview(page)).toBeVisible();
    await expect(page.getByText("连接设置入口", { exact: true })).toHaveCount(0);
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("a reachable member offers one departure action; coordinator removal is the fallback", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    await overview(page).locator(".network-member").nth(1).click();
    const detail = page.getByRole("dialog", { name: "示例电脑", exact: true });
    const danger = detail.getByRole("region", { name: "危险操作", exact: true });
    await expect(danger.getByRole("button")).toHaveText(["退出网络"]);
    await expect(detail.locator(".network-detail-section").getByRole("button", { name: "退出网络" })).toHaveCount(0);
    const leave = page.getByRole("dialog", { name: "让「示例电脑」退出网络？", exact: true });
    // Devices that are not ready have a remedy; forcing removal is not offered.
    await page.evaluate(() => (window as any).networkFixture.failLeave(1, "network_devices_not_ready"));
    await danger.getByRole("button", { name: "退出网络", exact: true }).click();
    await expect(leave.getByRole("button", { name: "只想从此设备移除这台主机的连接？", exact: true })).toBeVisible();
    await leave.getByRole("button", { name: "退出网络", exact: true }).click();
    await expect(leave.getByRole("alert")).toContainText("请先让手机打开 App");
    await leave.getByRole("button", { name: "返回", exact: true }).last().click();
    await expect(danger.getByRole("button")).toHaveText(["退出网络"]);
    // A host this device cannot act for is translated, then removal is offered.
    await page.evaluate(() => (window as any).networkFixture.failLeave(1, "network_local_owner_required"));
    await danger.getByRole("button", { name: "退出网络", exact: true }).click();
    await leave.getByRole("button", { name: "退出网络", exact: true }).click();
    await expect(leave.getByRole("alert")).toContainText("最初配对它的设备");
    await expect(leave.getByRole("alert")).not.toContainText("操作未完成");
    await leave.getByRole("button", { name: "返回", exact: true }).last().click();
    await expect(danger.getByRole("button")).toHaveText(["退出网络", "移出网络"]);
    expect((await inspectCalls(page)).map(call => [call.host, call.command.operation])).toEqual([[1, "leave"], [1, "leave"]]);
  } finally { await page.close(); await vite.close(); }
});

test("adding a device opens its coordinator QR directly and keeps reverse connection separate", async ({ page }, info) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { (window as any).networkFixture.overview(); (window as any).networkFixture.deviceApproval(true); });
    await overview(page).getByRole("button", { name: "添加设备", exact: true }).click();
    await expect(page.getByText("确认新设备入口：0:invite", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "添加设备", exact: true })).toHaveCount(0);
    await expect(overview(page).getByRole("button", { name: /此设备连接另一台主机/ })).toBeVisible();
    await overview(page).screenshot({ path: info.outputPath("network-add-device.png") });
    await overview(page).getByRole("button", { name: "输入配对码确认", exact: true }).click();
    await expect(page.getByText("确认新设备入口：0:approve", { exact: true })).toBeVisible();
    await page.evaluate(() => { (window as any).networkFixture.localController(true); (window as any).networkFixture.singleton(); });
    await expect(overview(page).getByRole("button", { name: /^本机加入另一个网络/ })).toContainText("确认后才会加入");
    await page.evaluate(() => (window as any).networkFixture.authorityAccess("member"));
    await overview(page).getByRole("button", { name: "添加设备", exact: true }).click();
    const add = page.getByRole("dialog", { name: "添加设备", exact: true });
    await expect(add).toContainText("没有「example-mac」的管理权限");
    await expect(add.getByRole("button", { name: "显示连接二维码", exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).networkFixture.authorityAccess("owner"); (window as any).networkFixture.offlineAuthority(); });
    await expect(add).toContainText("离线，恢复连接后才能确认新设备");
    await add.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await overview(page).getByRole("button", { name: /^本机加入另一个网络/ }).click();
    await expect(page.getByText("配对入口", { exact: true })).toBeVisible();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("standalone hosts require explicit selection and keep the opening host identity", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { (window as any).networkFixture.standaloneAll(); (window as any).networkFixture.deviceApproval(true); });
    await overview(page).getByRole("button", { name: "添加设备", exact: true }).click();
    const add = page.getByRole("dialog", { name: "添加设备", exact: true });
    await expect(add).toContainText("选择新设备要连接的主机");
    await expect(add.locator(".network-option")).toHaveCount(2);
    await add.locator(".network-option").nth(1).click();
    await expect(page.getByText("确认新设备入口：1:invite", { exact: true })).toBeVisible();
    await expect(add).toHaveCount(0);
    await page.evaluate(() => (window as any).networkFixture.openFor(0));
    await overview(page).getByRole("button", { name: "添加设备", exact: true }).click();
    await expect(page.getByText("确认新设备入口：0:invite", { exact: true })).toBeVisible();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("an unsaved host name asks before leaving, survives background renames and cannot close while saving", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview());
    const row = overview(page).locator(".network-member").first();
    await row.focus(); await page.keyboard.press("Enter");
    const detail = page.getByRole("dialog", { name: "example-mac", exact: true });
    const discard = page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true });
    // Opening the editor without typing, then a rename from another device, is not a draft.
    await detail.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await page.evaluate(() => (window as any).networkFixture.renameElsewhere());
    const renamed = page.getByRole("dialog", { name: "其他设备的新名称", exact: true });
    await renamed.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(discard).toHaveCount(0);
    await expect(renamed).toHaveCount(0);
    await row.focus(); await page.keyboard.press("Enter");
    await renamed.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await renamed.getByLabel("主机名称", { exact: true }).fill("未保存的改名检查");
    await renamed.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(discard).toContainText("主机名称尚未保存");
    await discard.getByRole("button", { name: "继续编辑", exact: true }).last().click();
    await expect(discard).toHaveCount(0);
    await expect(renamed.getByLabel("主机名称", { exact: true })).toHaveValue("未保存的改名检查");
    await renamed.getByLabel("主机名称", { exact: true }).focus(); await page.keyboard.press("Escape");
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(discard).toHaveCount(0);
    await expect(renamed.getByLabel("主机名称", { exact: true })).toHaveValue("未保存的改名检查");
    await renamed.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(renamed).toHaveCount(0);
    await expect(row).toBeFocused();
    expect(await page.evaluate(() => (window as any).networkFixture.profileWrites.length)).toBe(0);
    // A save in progress keeps the page open; the confirmed name closes the editor.
    await row.focus(); await page.keyboard.press("Enter");
    await expect(renamed.getByLabel("主机名称", { exact: true })).toHaveCount(0);
    await renamed.getByRole("button", { name: "修改主机名称", exact: true }).click();
    await renamed.getByLabel("主机名称", { exact: true }).fill("保存中的名称");
    await page.evaluate(() => (window as any).networkFixture.holdProfile());
    await renamed.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(renamed.getByRole("button", { name: "返回设备与网络", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(renamed).toBeVisible();
    await expect(discard).toHaveCount(0);
    await page.evaluate(() => (window as any).networkFixture.releaseProfile());
    const saved = page.getByRole("dialog", { name: "保存中的名称", exact: true });
    await expect(saved.getByLabel("主机名称", { exact: true })).toHaveCount(0);
    await saved.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(saved).toHaveCount(0);
    await expect(discard).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).networkFixture.profileWrites.length)).toBe(1);
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("hosts that cannot join stay listed with their reason", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await expect(overview(page).getByRole("button", { name: "加入网络", exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).networkFixture.sourceAccess("member"));
    await expect(overview(page).getByRole("button", { name: "加入网络", exact: true })).toHaveCount(0);
    const unjoined = overview(page).getByRole("region", { name: "未加入网络", exact: true });
    await expect(unjoined.locator(".network-member")).toHaveCount(1);
    await expect(unjoined).toContainText("此设备没有这台主机的管理权限");
    await page.evaluate(() => (window as any).networkFixture.sourceOnline(false));
    await expect(unjoined.locator(".network-member-status")).toHaveText("离线");
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("empty states lead to a real next step", async ({ page }, info) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.standaloneAll());
    await expect(overview(page).getByRole("heading", { name: "还没有组网", exact: true })).toBeVisible();
    await expect(overview(page).getByRole("button", { name: "创建网络", exact: true })).toBeEnabled();
    await expect(overview(page).getByRole("region", { name: "已配对主机", exact: true }).locator(".network-member")).toHaveCount(2);
    await expect(overview(page).getByRole("button", { name: "添加设备", exact: true })).toBeVisible();
    await overview(page).screenshot({ path: info.outputPath("network-standalone.png") });
    await page.evaluate(() => (window as any).networkFixture.noHosts());
    await expect(overview(page).getByRole("heading", { name: "还没有连接主机", exact: true })).toBeVisible();
    await overview(page).screenshot({ path: info.outputPath("network-no-hosts.png") });
    await overview(page).getByRole("button", { name: "连接主机", exact: true }).click();
    await expect(page.getByText("配对入口", { exact: true })).toBeVisible();
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

for (const width of [320, 390]) test(`host detail and confirmation fit a ${width}px phone`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 740 });
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.overview(["example-mac", "Long host name ".repeat(5)]));
    await overview(page).locator(".network-member").nth(1).click();
    const detail = page.getByRole("dialog", { name: "Long host name ".repeat(5).trim(), exact: false });
    await expect(detail.getByRole("region", { name: "危险操作", exact: true })).toBeVisible();
    await detail.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
    expect(await detail.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    for (const target of await detail.locator("button").all()) {
      const box = (await target.boundingBox())!;
      expect(box.height, await target.evaluate(node => node.outerHTML.slice(0, 160))).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await detail.screenshot({ path: info.outputPath(`network-detail-${width}.png`) });
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await detail.screenshot({ path: info.outputPath(`network-detail-${width}-dark.png`) });
    await page.evaluate(() => document.documentElement.dataset.theme = "light");
    await detail.getByRole("button", { name: "退出网络", exact: true }).click();
    const leave = page.getByRole("dialog", { name: /退出网络？$/ });
    await leave.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
    expect(await leave.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await leave.screenshot({ path: info.outputPath(`network-leave-${width}.png`) });
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});

test("an opening host selects its network once without taking later selections away", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => (window as any).networkFixture.ownMultiHostNetwork());
    const select = overview(page).getByRole("combobox", { name: "网络", exact: true });
    await expect(overview(page).locator(".network-summary-name")).toHaveText("工作网络");
    await expect(select).toHaveValue(/:network-fixture$/);
    await page.evaluate(() => (window as any).networkFixture.openFor(1));
    await expect(select).toHaveValue(/:other-network$/);
    await expect(overview(page).locator(".network-member").first()).toContainText("协调");
    await select.selectOption({ index: 0 });
    await expect(select).toHaveValue(/:network-fixture$/);
    await page.evaluate(() => { (window as any).networkFixture.sourceOnline(false); (window as any).networkFixture.sourceOnline(true); });
    await overview(page).getByRole("button", { name: "刷新网络", exact: true }).click();
    await expect(select).toHaveValue(/:network-fixture$/);
    await page.evaluate(() => (window as any).networkFixture.openFor(1, true));
    const detail = page.getByRole("dialog", { name: "同名主机", exact: true });
    await expect(detail).toContainText("协调主机：负责确认新主机和新设备");
    await detail.getByRole("button", { name: "返回设备与网络", exact: true }).click();
    await expect(select).toHaveValue(/:other-network$/);
    expect(await inspectCalls(page)).toHaveLength(0);
  } finally { await page.close(); await vite.close(); }
});


test("multiple local paths remain shareable through the legacy single-direct directory", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => { const f = (window as any).networkFixture; f.requireRouteReview(1); f.multipleRoutes(1); });
    await overview(page).getByRole("button", { name: "加入网络", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    await join.getByRole("button", { name: "准备「同名主机」的连接线路", exact: true }).click();
    const routes = page.getByRole("dialog", { name: "同步主机地址", exact: true });
    await expect(routes).toContainText("https://100.80.1.20:8788");
    await expect(routes).toContainText("https://relay.example");
    await routes.getByRole("button", { name: "确认同步", exact: true }).click();
    const command = (await inspectCalls(page)).find(call => call.command.operation === "routes")!.command;
    expect(command).toMatchObject({ operation: "routes", routes: [{ name: "Tailscale", url: "https://100.80.1.20:8788" }, { name: "VPS", url: "https://relay.example" }] });
    await expect(join.getByRole("checkbox")).toBeEnabled();
  } finally { await page.close(); await vite.close(); }
});
