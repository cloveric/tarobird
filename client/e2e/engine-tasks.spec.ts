import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
for (const phone of [false, true]) test(`${phone ? "phone" : "desktop"}: task list separates foreground/background and stops only the selected task`, async ({ page }, info) => {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  const trigger = page.getByRole("button", { name: "子代理与后台任务", exact: true });
  await expect(trigger).toContainText("3 个任务执行中"); await trigger.click();
  const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true });
  await expect(dialog.getByRole("article")).toHaveCount(3);
  const alpha = dialog.getByRole("article", { name: "检查 iPhone 键盘与滚动", exact: true });
  await alpha.getByText("最近进展", { exact: true }).click();
  await expect(alpha).toContainText("正在核对列表的滚动位置");
  await expect(dialog.getByRole("article", { name: "读取配置", exact: true })).toContainText("父代理正在等待");
  await expect(dialog.getByRole("article", { name: "读取配置", exact: true })).toContainText("所属任务：检查 iPhone 键盘与滚动");
  await expect(dialog.getByRole("article", { name: "读取配置", exact: true }).getByRole("button")).toHaveCount(0);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("tasks.png") });
  await alpha.getByRole("button", { name: "停止此任务", exact: true }).click();
  await expect(alpha).toContainText("已停止");
  await expect(dialog.getByRole("article", { name: "检查消息队列", exact: true })).toContainText("执行中");
  expect(await page.evaluate(() => (window as any).taskFixture.calls.filter((c: any) => c.input).map((c: any) => c.input.taskId))).toEqual(["alpha"]);
  await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click(); await expect(trigger).toBeFocused();
});
test("uncertain stop checks the same receipt and keeps other tasks running", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
  await page.evaluate(() => (window as any).taskFixture.uncertain(true));
  const alpha = page.getByRole("article", { name: "检查 iPhone 键盘与滚动", exact: true });
  await alpha.getByRole("button", { name: "停止此任务", exact: true }).click();
  await expect(alpha).toContainText("停止结果待确认"); await expect(alpha).toContainText("执行中");
  await page.evaluate(() => (window as any).taskFixture.uncertain(false));
  await alpha.getByRole("button", { name: "核对停止结果", exact: true }).click();
  await expect(alpha).toContainText("已停止");
  const calls = await page.evaluate(() => (window as any).taskFixture.calls.filter((c: any) => c.input).map((c: any) => c.input));
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
});
test("hidden panes stop polling; offline task state stays unconfirmed", async ({ page }) => {
  await page.clock.install(); await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
  await page.evaluate(() => (window as any).taskFixture.setOnline(false));
  await expect(page.getByRole("dialog")).toContainText("连接中断，当前状态待确认");
  await expect(page.getByRole("button", { name: "停止此任务", exact: true }).first()).toBeDisabled();
  await page.evaluate(() => (window as any).taskFixture.setActive(false));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const count = await page.evaluate(() => (window as any).taskFixture.calls.length);
  await page.clock.runFor(20_000); expect(await page.evaluate(() => (window as any).taskFixture.calls.length)).toBe(count);
});

test("reports native foreground stop impact without implying isolated cancellation", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  await page.evaluate(() => (window as any).taskFixture.stopScope());
  await expect(page.locator(".engine-tasks-stop-impact")).toHaveCount(0);
  await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("可在任务列表单独停止");
  expect(await page.evaluate(() => (window as any).taskFixture.calls.some((c: any) => c.input))).toBe(false);
});

test("a definitive rejection permits a fresh explicit stop while uncertain outcomes retain their ID", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
  await page.evaluate(() => (window as any).taskFixture.rejectOnce());
  const alpha = page.getByRole("article", { name: "检查 iPhone 键盘与滚动", exact: true });
  await alpha.getByRole("button", { name: "停止此任务", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("当前无法停止");
  await alpha.getByRole("button", { name: "停止此任务", exact: true }).click(); await expect(alpha).toContainText("已停止");
  const calls = await page.evaluate(() => (window as any).taskFixture.calls.filter((c: any) => c.input).map((c: any) => c.input));
  expect(calls).toHaveLength(2); expect(calls[0].requestId).not.toBe(calls[1].requestId);
});


test("an uncertain native receipt permits only an explicit new stop after a fresh running snapshot", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
  await page.evaluate(() => (window as any).taskFixture.unknownOnce());
  const alpha = page.getByRole("article", { name: "检查 iPhone 键盘与滚动", exact: true });
  await alpha.getByRole("button", { name: "停止此任务", exact: true }).click();
  await expect(alpha.getByRole("button", { name: "重新请求停止", exact: true })).toBeEnabled();
  await alpha.getByRole("button", { name: "核对停止结果", exact: true }).click();
  await expect(alpha).toContainText("停止结果待确认");
  await alpha.getByRole("button", { name: "重新请求停止", exact: true }).click();
  await expect(alpha).toContainText("已停止");
  const calls = await page.evaluate(() => (window as any).taskFixture.calls.filter((c: any) => c.input).map((c: any) => c.input));
  expect(calls).toHaveLength(3); expect(calls[0]).toEqual(calls[1]); expect(calls[2].requestId).not.toBe(calls[0].requestId);
});

test("child steps direct users to their parent; forced recovery needs explicit scoped confirmation", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html");
  await page.evaluate(() => { (window as any).taskFixture.child(); (window as any).taskFixture.recovery(); });
  await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
  const child = page.getByRole("article", { name: "读取配置", exact: true });
  await expect(child).toContainText("请停止所属子代理"); await expect(child.getByRole("button")).toHaveCount(0);
  const recovery = page.getByRole("region", { name: "恢复停止未确认的会话", exact: true });
  await recovery.getByRole("button", { name: "强制结束此会话进程…", exact: true }).click();
  await expect(recovery).toContainText("全部后台任务"); await expect(recovery.getByRole("list")).toContainText("检查消息队列");
  expect(await page.evaluate(() => (window as any).taskFixture.calls.filter((c: any) => c.input).length)).toBe(0);
  await recovery.getByRole("button", { name: "确认强制结束", exact: true }).click();
  await expect(recovery).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).taskFixture.calls.filter((c: any) => c.input));
  expect(calls).toHaveLength(1); expect(calls[0].route).toBe("/api/conversations/chat/tasks/recover"); expect(calls[0].input.token).toBe("fence");
});
