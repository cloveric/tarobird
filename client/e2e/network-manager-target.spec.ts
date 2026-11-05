import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

async function fixture(page: Page) {
  const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/e2e/fixtures/network-manager.tsx"></script></body></html>';
  const vite = await createServer({ optimizeDeps: { entries: ["e2e/fixtures/network-manager.tsx"] }, plugins: [{ name: "network-target-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__network-target") return next(); response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml("/__network-target", html)); }); } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await vite.listen(); await page.goto(vite.resolvedUrls!.local[0]! + "__network-target"); return vite;
}

test("creating a network starts on the host whose settings were opened", async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(() => {
      const f = (window as any).networkFixture;
      f.overview(["另一台电脑", "当前工作站"]); f.standaloneAll(); f.openFor(1);
    });
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "创建网络", exact: true }).click();
    const create = page.getByRole("dialog", { name: "创建网络", exact: true });
    await create.getByRole("button", { name: "创建网络", exact: true }).click();
    await expect(create).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).networkFixture.calls);
    expect(calls).toEqual([{ host: 1, command: { operation: "create", name: "当前工作站的网络" } }]);
  } finally { await page.close(); await vite.close(); }
});

for (const joining of [false, true]) test(`shared route back label matches its parent (${joining ? "join" : "host details"})`, async ({ page }) => {
  const vite = await fixture(page);
  try {
    await page.evaluate(joining => {
      const f = (window as any).networkFixture;
      if (!joining) f.overview();
      f.noShareableRoutes(1);
    }, joining);
    const overview = page.getByRole("dialog", { name: "设备与网络", exact: true });
    if (joining) {
      await overview.getByRole("button", { name: "加入网络", exact: true }).click();
      await page.getByRole("dialog", { name: "加入网络", exact: true }).locator(".network-join-route").filter({ hasText: "尚未共享线路" }).getByRole("button", { name: "检查或同步地址", exact: true }).click();
    } else {
      await overview.locator(".network-member").nth(1).click();
      await page.getByRole("dialog", { name: "示例电脑", exact: true }).getByRole("button", { name: "同步主机地址", exact: true }).click();
    }
    const routes = page.getByRole("dialog", { name: "同步主机地址", exact: true });
    await routes.getByRole("button", { name: joining ? "返回加入网络" : "返回主机详情", exact: true }).click();
    await expect(routes).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: joining ? "加入网络" : "示例电脑", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).networkFixture.calls)).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});
