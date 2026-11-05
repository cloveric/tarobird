import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

for (const phone of [false, true]) test(`${phone ? "phone" : "desktop"} scopes stay visible in event order, search, pages and export without a background stop`, async ({ page }, info) => {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html");
  const background = page.locator(".native-run").filter({ hasText: "后台任务" });
  await expect(background).toContainText("后台公开正文");
  await expect(background.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(page.locator(".native-run").last().getByRole("button", { name: "停止", exact: true })).toHaveCount(1);
  await expect(background).not.toContainText("1 个动作失败");
  await background.getByRole("button", { name: "查看运行过程", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "运行过程", exact: true });
  await expect(panel.locator(".run-step")).toHaveCount(40);
  await expect(panel.locator(".run-details-meta")).toContainText("1 个动作失败");
  const first = panel.locator(".run-step").first();
  await expect(first.locator("summary")).toContainText("子代理 · 核对报告");
  await expect(first.locator("summary")).not.toContainText("agent-call-1");
  await expect(panel.locator(".run-step").nth(1).locator("summary")).toContainText("后台任务 · 资料检索");
  await expect(panel.locator(".run-step").nth(1).locator("summary")).not.toContainText("background-call-1");
  await first.locator("summary").first().click();
  await expect(first).toContainText("公开步骤 1");
  await expect(first).toContainText("作用域：child-1");
  await expect(first).toContainText("父作用域：background-1 · 父调用：agent-call-1");
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("scoped-journal.png") });
  await panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(panel.locator(".run-step")).toHaveCount(2);
  await expect(panel.locator(".run-step").first()).toContainText("子代理 · 核对报告");
  await panel.locator(".run-step").first().locator("summary").first().click();
  await expect(panel.locator(".run-step").first()).toContainText("公开步骤 41");
  await panel.getByRole("textbox", { name: "搜索过程记录" }).fill("agent-call-1");
  await panel.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(panel.locator(".run-step")).toHaveCount(21);
  await expect(panel.locator(".run-step-scope").first()).toContainText("子代理 · 核对报告");
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出过程记录" }).click();
  const saved = await download;
  const exported = JSON.parse(await readFile((await saved.path())!, "utf8"));
  expect(exported.entries).toHaveLength(42);
  expect(exported.entries.map((entry: { seq: number }) => entry.seq)).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
  expect(exported.entries[0].scope).toMatchObject({ id: "child-1", kind: "subagent", parentId: "background-1", parentCallId: "agent-call-1" });
  expect(exported.entries[41].scope).toMatchObject({ id: "background-1", kind: "background" });
  const observed = await page.evaluate(() => (window as any).runScopesFixture);
  expect(observed.urls.every((url: string) => new URL(url, "https://fixture.test").searchParams.get("scopes") === "1")).toBe(true);
  expect(observed.sent).toEqual([]);
});

test("terminal details catch up delayed scope writes, then stop polling and allow a manual refresh", async ({ page }) => {
  await page.clock.install();
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html");
  await page.locator(".native-run").first().getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(40);
  await page.evaluate(() => (window as any).runScopesFixture.finish());
  await expect(page.locator(".run-step")).toHaveCount(0);
  await page.clock.runFor(3000);
  await page.evaluate(() => (window as any).runScopesFixture.deliver());
  await page.clock.runFor(1000);
  await expect(page.locator(".run-step")).toHaveCount(40);
  await page.clock.runFor(8000);
  const settled = await page.evaluate(() => (window as any).runScopesFixture.urls.length);
  await page.clock.runFor(15000);
  expect(await page.evaluate(() => (window as any).runScopesFixture.urls.length)).toBe(settled);
  await page.getByRole("button", { name: "刷新过程记录", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).runScopesFixture.urls.length)).toBe(settled + 1);
});

test("a confirmed final scope-write failure shows incomplete details while keeping the background reply readable", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html");
  await page.locator(".native-run").first().getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(40);
  await page.evaluate(() => (window as any).runScopesFixture.fail());
  await expect(page.locator(".run-step")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "运行过程", exact: true })).toContainText("部分过程尚未同步，回复不受影响。");
  await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
  const background = page.locator(".native-run").first();
  await expect(background).toContainText("后台公开正文");
  await expect(background.locator(".native-run-status")).toContainText("已完成");
  await expect(background.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
});


test("a healthy scoped drain beyond the polling window stays pending and refreshes on acknowledgement", async ({ page }) => {
  await page.clock.install();
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html");
  await page.locator(".native-run").first().getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.evaluate(() => (window as any).runScopesFixture.finish());
  await expect(page.locator(".run-step")).toHaveCount(0);
  await page.clock.runFor(15000);
  const settled = await page.evaluate(() => (window as any).runScopesFixture.urls.length);
  await page.clock.runFor(15000);
  expect(await page.evaluate(() => (window as any).runScopesFixture.urls.length)).toBe(settled);
  const panel = page.getByRole("dialog", { name: "运行过程", exact: true });
  await expect(panel).toContainText("过程记录正在同步，回复已可查看。");
  await expect(panel).not.toContainText("部分过程尚未同步，回复不受影响。");
  await page.evaluate(() => (window as any).runScopesFixture.confirm());
  await expect(page.locator(".run-step")).toHaveCount(40);
  await expect(panel).not.toContainText("过程记录正在同步，回复已可查看。");
  expect(await page.evaluate(() => (window as any).runScopesFixture.urls.length)).toBe(settled + 1);
});

test("historical process details read once without a terminal polling burst", async ({ page }) => {
  await page.clock.install();
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html?history=1");
  await page.locator(".native-run").first().getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(40);
  await page.clock.runFor(20000);
  expect(await page.evaluate(() => (window as any).runScopesFixture.urls.length)).toBe(1);
});

test("isolated foreground subagents stay read-only and are labeled as subagents", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html?child=1");
  const child = page.locator(".native-run").first();
  await expect(child).toContainText("子代理");
  await expect(child).not.toContainText("后台任务");
  await expect(child.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
});

test("a rolled-back Hub keeps scoped replies readable without asserting ongoing progress", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-scopes.html?rollback=1");
  const background = page.locator(".native-run").first();
  await expect(background).toContainText("后台公开正文");
  await expect(background).toContainText("最后状态待确认");
  await expect(background).toContainText("当前连接暂不提供子任务过程，已保留公开回复。");
  await expect(background.locator(".spin")).toHaveCount(0);
  await expect(background.getByRole("button", { name: "查看运行过程", exact: true })).toHaveCount(0);
  await expect(background.getByRole("button", { name: "查看完整回复", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).runScopesFixture.sent)).toEqual([]);
});
