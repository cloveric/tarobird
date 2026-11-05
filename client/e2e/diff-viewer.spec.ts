import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "diff-viewer-fixture", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/__diff")) return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__diff", '<!doctype html><html lang="zh"><body><div id="root"></div><script type="module" src="/e2e/fixtures/diff-viewer.tsx"></script></body></html>'));
  }); } }], server: { host: "127.0.0.1", port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0] + "__diff";
});
test.afterAll(async () => { await server.close(); });
test("mobile loads only selected file, has line numbers and no annotations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await expect(page.getByRole("button", { name: /src\/components\/ReviewPanel/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).diffFixture.requests.filter((r: string) => r.includes("/file?")).length)).toBe(0);
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toContainText("visibleNotes"); await expect(page.getByRole("complementary", { name: "审阅批注" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /批注第/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "切换左右对比" })).toHaveCount(0);
  if (process.env.DIFF_SCREENSHOTS) await page.screenshot({ path: process.env.DIFF_SCREENSHOTS + "/mobile-diff.png" });
  await page.getByRole("button", { name: "返回改动文件" }).click(); await expect(page.getByRole("button", { name: /src\/theme.css/ })).toBeVisible();
});
test("desktop single and multi line notes persist and clear only on accepted message", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url);
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  const codeStarts = await Promise.all([1, 2, 4, 6].map(line => page.getByRole("button", { name: `批注第 ${line} 行（新）`, exact: true }).locator("code").evaluate(node => node.getBoundingClientRect().left)));
  expect(Math.max(...codeStarts) - Math.min(...codeStarts)).toBeLessThan(1);
  const added = page.getByRole("button", { name: "批注第 2 行（新）", exact: true });
  const background = await added.evaluate(node => getComputedStyle(node).backgroundColor);
  await added.hover(); expect(await added.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(background);
  await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click();
  await page.getByRole("textbox", { name: "批注意见" }).fill("请保留原顺序，并补充空列表测试。");
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  await page.getByRole("button", { name: "批注第 4 行（新）", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByRole("textbox", { name: "批注意见" }).nth(1).fill("这三行可以提取为独立函数。");
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "批注意见" }).nth(1)).toHaveValue("这三行可以提取为独立函数。");
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toContainText("visibleNotes");
  if (process.env.DIFF_SCREENSHOTS) await page.screenshot({ path: process.env.DIFF_SCREENSHOTS + "/desktop-diff-notes.png" });
  await page.getByRole("button", { name: "切换左右对比" }).click();
  await page.getByRole("button", { name: "发送批注给 Bot" }).click();
  await expect(page.getByText("批注已排队，等待主机确认。")).toBeVisible(); await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveCount(2);
  await page.evaluate(() => (window as any).diffFixture.ack());
  await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveCount(0);
  const sent = await page.evaluate(() => (window as any).diffFixture.sent[0]);
  expect(sent.type).toBe("message.send"); expect(sent.conversationId).toBe("conversation"); expect(sent.mentions).toEqual(["bot"]); expect(sent.text).toContain("新文件 2–4 行"); expect(sent.text).toContain("这三行可以提取为独立函数。");
});

test("short split rows fit and wide Unicode code can be scrolled to its end", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url + "?mode=shortcode");
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await page.getByRole("button", { name: "切换左右对比" }).click();
  await expect.poll(() => page.getByTestId("diff-code").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThan(2);
  await page.goto(url + "?mode=widecode&emptyFont=1"); await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await page.getByTestId("diff-code").evaluate(node => node.scrollLeft = node.scrollWidth);
  const bounds = await page.locator(".diff-code-cell.is-add code").first().evaluate(node => {
    const viewport = node.closest(".diff-code-scroll")!.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(node);
    return { tail: range.getBoundingClientRect().right, right: viewport.right };
  });
  expect(bounds.tail).toBeLessThanOrEqual(bounds.right + 1);
});

test("changed or removed files and non-route 404 explain the actual state", async ({ page }) => {
  await page.goto(url + "?mode=changing"); await expect(page.getByText("读取期间文件或仓库发生变化，请刷新后重试。")).toBeVisible();
  await page.goto(url + "?mode=missing"); await expect(page.getByText("对话、Bot 或工作区已不可用，请返回对话列表检查。")).toBeVisible();
  await expect(page.getByText("此主机尚不支持改动查看，请更新主机。")).toHaveCount(0);
  await page.goto(url + "?mode=gone"); await expect(page.getByText("对话、Bot 或工作区已不可用，请返回对话列表检查。")).toBeVisible();
  await page.goto(url); await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toBeVisible();
  await page.evaluate(() => (window as any).diffFixture.removeFirst()); await page.getByRole("button", { name: "刷新工作区改动" }).click();
  await expect(page.getByText("文件已不在当前改动中，请刷新文件列表。")).toBeVisible();
});

test("failed saves can be copied or explicitly discarded without trapping the dialog", async ({ page }) => {
  await page.goto(url); await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click();
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  await page.evaluate(() => (window as any).diffFixture.breakSave());
  await page.getByRole("textbox", { name: "批注意见" }).fill("keep unsaved text");
  await expect(page.getByRole("button", { name: "复制当前批注" })).toBeVisible();
  await page.getByRole("button", { name: "关闭改动查看器" }).click();
  await expect(page.getByRole("dialog", { name: "放弃未保存批注并关闭？" })).toBeVisible();
  expect(await nativeBack(page)).toBe(true);
  await expect(page.getByRole("dialog", { name: "放弃未保存批注并关闭？" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "工作区改动", exact: true })).toHaveClass(/has-file/);
  await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveValue("keep unsaved text");
  expect(await nativeBack(page)).toBe(true);
  await expect(page.getByRole("dialog", { name: "工作区改动", exact: true })).not.toHaveClass(/has-file/);
  await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveValue("keep unsaved text");
  expect(await nativeBack(page)).toBe(true);
  await page.getByRole("dialog", { name: "放弃未保存批注并关闭？", exact: true }).getByRole("button", { name: "放弃未保存修改并关闭", exact: true }).click();
  await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
test("large file is opt-in prefix preview, virtualized and responsive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url); await page.getByRole("button", { name: /large.txt/ }).click();
  await expect(page.getByText("改动过大，默认不加载代码内容。")).toBeVisible(); await expect(page.getByTestId("diff-code")).toHaveCount(0);
  await page.getByRole("button", { name: "只看前 200 行" }).click(); await expect(page.getByTestId("diff-code")).toContainText("row1");
  expect(await page.locator(".diff-code-row").count()).toBeLessThan(60);
  await page.getByTestId("diff-code").evaluate(node => node.scrollTop = 10000); await expect(page.getByTestId("diff-code")).toContainText("row200");
  await expect(page.getByText("这是文件文本的前 200 行预览，不是完整差异。")).toBeVisible();
});
for (const [mode, text] of [["nongit", "这个 Bot 的工作区不是 Git 仓库。"], ["old", "此主机尚不支持改动查看，请更新主机。"], ["404", "此主机尚不支持改动查看，请更新主机。"]]) test(`${mode} has an explicit explanation`, async ({ page }) => {
  await page.goto(url + "?mode=" + mode); await expect(page.getByText(text!)).toBeVisible();
});
test("binary/protected files and generated files do not fetch unnecessary content", async ({ page }) => {
  await page.goto(url); await expect(page.getByRole("button", { name: /package-lock.json/ })).not.toBeVisible();
  await page.getByRole("button", { name: /image.png/ }).click(); await expect(page.getByText("二进制文件，仅显示改动状态。")).toBeVisible();
  await page.getByRole("button", { name: /.env/ }).click(); await expect(page.getByText("此路径可能包含凭据，不提供内容预览。")).toBeVisible();
  expect(await page.evaluate(() => (window as any).diffFixture.requests.some((r: string) => r.includes("path=.env")))).toBe(false);
});
test("wide native Android has no annotation controls", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 }); await page.goto(url + "?mode=android"); await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toBeVisible(); await expect(page.getByRole("button", { name: /批注第/ })).toHaveCount(0); await expect(page.getByRole("complementary", { name: "审阅批注" })).toHaveCount(0);
});
test("failed review retains notes, retries exact frame and can be abandoned", async ({ page }) => {
  await page.goto(url); await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click(); await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click(); await page.getByRole("textbox", { name: "批注意见" }).fill("请处理空值"); await expect(page.getByText("正在保存批注…")).toHaveCount(0); await page.getByRole("button", { name: "发送批注给 Bot" }).click();
  await expect(page.getByText("批注已排队，等待主机确认。")).toBeVisible();
  const before = await page.evaluate(async () => (await (window as any).diffFixture.cache.outbox())[0].frame);
  await page.evaluate(() => (window as any).diffFixture.fail()); await page.getByRole("button", { name: "重试原消息" }).click();
  await expect(page.getByText("批注已排队，等待主机确认。")).toBeVisible(); expect(await page.evaluate(async () => (await (window as any).diffFixture.cache.outbox())[0].frame)).toEqual(before);
  await page.evaluate(() => (window as any).diffFixture.fail()); await page.getByRole("button", { name: "取消本次发送，保留批注" }).click(); await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveValue("请处理空值"); await expect(page.getByRole("button", { name: "发送批注给 Bot" })).toBeEnabled();
});

// Match the cancellable event emitted by the production Android Back bridge.
const nativeBack = (page: import("@playwright/test").Page) => page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
for (const width of [390, 1440]) for (const action of ["native", "escape"]) test(`diff back returns from detail to list before closing (${width}, ${action})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto(url);
  const dialog = page.getByRole("dialog", { name: "工作区改动", exact: true });
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toBeVisible();
  const back = async () => { if (action === "native") expect(await nativeBack(page)).toBe(true); else await page.keyboard.press("Escape"); };
  await back();
  await expect(dialog).toBeVisible(); await expect(dialog).not.toHaveClass(/has-file/);
  await expect(page.getByRole("button", { name: /src\/components\/ReviewPanel/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回改动文件" })).toHaveCount(0);
  await back(); await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
test("explicit close still exits directly from a selected diff", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toBeVisible();
  await page.getByRole("button", { name: "关闭改动查看器" }).click();
  await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
for (const state of ["loading", "failed"]) test(`back leaves ${state} file detail without closing the list or accepting a late response`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await expect(page.getByRole("button", { name: /src\/components\/ReviewPanel/ })).toBeVisible();
  await page.evaluate(state => {
    const f = (window as any).diffFixture, http = f.connection.http.bind(f.connection);
    f.connection.http = async (route: string, init?: RequestInit) => {
      if (route.includes("/file?")) {
        if (state === "failed") throw new Error("fixture_file_failed");
        await new Promise<void>(resolve => { f.releaseFile = resolve; });
      }
      try { return await http(route, init); }
      finally { if (route.includes("/file?")) f.fileSettled = true; }
    };
  }, state);
  await page.getByRole("button", { name: /src\/components\/ReviewPanel/ }).click();
  if (state === "loading") await expect(page.getByText("正在读取文件改动…", { exact: true })).toBeVisible();
  else await expect(page.locator(".diff-content [role=alert]")).toBeVisible();
  expect(await nativeBack(page)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "工作区改动", exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog).not.toHaveClass(/has-file/);
  await page.evaluate(() => (window as any).diffFixture.releaseFile?.());
  if (state === "loading") await expect.poll(() => page.evaluate(() => !!(window as any).diffFixture.fileSettled)).toBe(true);
  await expect(page.getByRole("button", { name: /src\/components\/ReviewPanel/ })).toBeVisible();
  await expect(page.getByTestId("diff-code")).toHaveCount(0);
  expect(await nativeBack(page)).toBe(true); await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
