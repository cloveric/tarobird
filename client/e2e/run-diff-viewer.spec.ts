import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "recorded-diff-fixture", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/__run_diff")) return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__run_diff", '<!doctype html><html lang="zh"><body><div id="root"></div><script type="module" src="/e2e/fixtures/run-diff-viewer.tsx"></script></body></html>'));
  }); } }], server: { host: "127.0.0.1", port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0] + "__run_diff";
});
test.afterAll(async () => { await server.close(); });
const file = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ });
test("reply shows saved counts and opens recorded changes without workspace lookup", async ({ page }) => {
  await page.goto(url + "?mode=trigger");
  await page.getByRole("button", { name: "改动 1 个文件 · +4 −2" }).click();
  await file(page).click(); await expect(page.getByTestId("diff-code")).toContainText("one-1");
  expect(await page.evaluate(() => (window as any).runDiffFixture.requests.every((path: string) => path.includes("/messages/message-one/changes")))).toBe(true);
});
test("phone loads one selected operation, scrolls large preview, and offers no annotation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url + "?mode=android");
  await expect(file(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).runDiffFixture.requests.length)).toBe(1);
  await file(page).click(); await expect(page.getByTestId("diff-code")).toContainText("one-1");
  await expect(page.getByRole("button", { name: /批注第/ })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "审阅批注" })).toHaveCount(0);
  if (process.env.DIFF_SCREENSHOTS) await page.screenshot({ path: process.env.DIFF_SCREENSHOTS + "/mobile-recorded-diff.png" });
  await page.getByRole("button", { name: "返回改动文件" }).click();
  await page.getByRole("button", { name: /\/project\/large.txt/ }).click(); await page.getByRole("button", { name: "只看前 200 行" }).click();
  await expect(page.getByTestId("diff-code")).toContainText("generated");
  expect(await page.locator(".diff-code-row").count()).toBeLessThan(80);
});
test("two edits and two runs of the same file keep independent persistent notes and immutable sends", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await file(page).click();
  await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click(); await page.getByRole("textbox", { name: "批注意见" }).fill("修改步骤一的意见");
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  await page.getByRole("combobox", { name: "修改步骤" }).selectOption("2-0");
  await expect(page.getByTestId("diff-code")).toContainText("one-2"); await expect(page.locator(".diff-code-cell.has-note")).toHaveCount(0);
  await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click();
  await page.getByRole("button", { name: "批注第 3 行（新）", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByRole("textbox", { name: "批注意见" }).nth(1).fill("单行意见"); await page.getByRole("textbox", { name: "批注意见" }).nth(2).fill("多行意见");
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveCount(3);
  await file(page).click();
  await expect(page.getByTestId("diff-code")).toContainText("one-1");
  if (process.env.DIFF_SCREENSHOTS) await page.screenshot({ path: process.env.DIFF_SCREENSHOTS + "/desktop-recorded-diff-notes.png" });
  await page.goto(url + "?run=two"); await file(page).click(); await expect(page.locator(".diff-code-cell.has-note")).toHaveCount(0);
  await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click(); await page.getByRole("textbox", { name: "批注意见" }).nth(3).fill("第二轮意见");
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  const compatible = await page.evaluate(async () => {
    const f = (window as any).runDiffFixture, db = await f.cache.db;
    const raw = await db.get("settings", 'diff-review-draft:["conversation","bot"]');
    return f.storedDiffReviewDraftSchema.safeParse(JSON.parse(raw)).success;
  }); expect(compatible).toBe(true);
  await page.getByRole("button", { name: "发送批注给 Bot" }).click(); await expect(page.getByText("批注已排队，等待主机确认。")).toBeVisible();
  await page.evaluate(() => (window as any).runDiffFixture.ack()); await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveCount(0);
  const text = await page.evaluate(() => (window as any).runDiffFixture.sent[0].text);
  expect(text).toContain("message-one"); expect(text).toContain("message-two"); expect(text).toContain("修改步骤 2-0"); expect(text).toContain("当前文件可能已变化"); expect(text).not.toContain("HEAD：0000");
});
test("active, missing, expired and old-host states never pretend to be empty Git diffs", async ({ page }) => {
  for (const [mode, text] of [["active", "本轮仍在进行"], ["expired", "超过保存期限"], ["not_recorded", "不代表没有修改文件"], ["old", "请更新主机"]]) {
    await page.goto(url + "?mode=" + mode); await expect(page.getByRole("navigation", { name: "改动文件" })).toContainText(text!);
    expect(await page.evaluate(() => (window as any).runDiffFixture.requests.some((value: string) => value.includes("/conversations/")))).toBe(false);
  }
  await page.goto(url); await page.getByRole("button", { name: "当前工作区（实时）" }).click();
  await expect(page.getByText("这个 Bot 的工作区不是 Git 仓库。")).toBeVisible();
});

test("temporary admission failure retries reads and a finished run refreshes its open viewer", async ({ page }) => {
  await page.goto(url + "?mode=busy"); await expect(file(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).runDiffFixture.requests.length)).toBe(3);
  await page.goto(url + "?mode=finish"); await page.getByRole("button", { name: "本轮改动", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "改动文件" })).toContainText("本轮仍在进行");
  await page.evaluate(() => (window as any).runDiffFixture.finish());
  await file(page).click(); await expect(page.getByTestId("diff-code")).toContainText("one-1");
});
test("switching live and recorded views shares one draft and never navigates a run note as a workspace path", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url + "?mode=live"); await file(page).click();
  await page.getByRole("button", { name: "批注第 2 行（新）", exact: true }).click(); await page.getByRole("textbox", { name: "批注意见" }).fill("初稿");
  await page.getByRole("button", { name: "当前工作区（实时）" }).click();
  await expect(page.getByRole("heading", { name: "工作区改动", exact: true })).toBeVisible();
  await page.locator(".diff-note header button").first().click(); await expect(page.getByRole("alert")).toContainText("这条批注来自本轮记录");
  await page.getByRole("textbox", { name: "批注意见" }).fill("实时窗口修改");
  await page.getByRole("button", { name: "关闭改动查看器" }).click();
  await page.getByRole("textbox", { name: "批注意见" }).fill("立即切回修改");
  await expect(page.getByText("正在保存批注…")).toHaveCount(0);
  await expect(page.getByText("批注保存失败或已在另一窗口更改")).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("textbox", { name: "批注意见" })).toHaveValue("立即切回修改");
});

// Match the cancellable event emitted by the production Android Back bridge.
const nativeBack = (page: import("@playwright/test").Page) => page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
for (const width of [390, 1440]) for (const action of ["native", "escape"]) test(`diff back returns from detail to list before closing (${width}, ${action})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto(url);
  const dialog = page.getByRole("dialog", { name: "本轮改动", exact: true });
  await page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toBeVisible();
  const back = async () => { if (action === "native") expect(await nativeBack(page)).toBe(true); else await page.keyboard.press("Escape"); };
  await back();
  await expect(dialog).toBeVisible(); await expect(dialog).not.toHaveClass(/has-file/);
  await expect(page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回改动文件" })).toHaveCount(0);
  await back(); await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
test("explicit close still exits directly from a selected diff", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ }).click();
  await expect(page.getByTestId("diff-code")).toBeVisible();
  await page.getByRole("button", { name: "关闭改动查看器" }).click();
  await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
for (const state of ["loading", "failed"]) test(`back leaves ${state} file detail without closing the list or accepting a late response`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await expect(page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ })).toBeVisible();
  await page.evaluate(state => {
    const f = (window as any).runDiffFixture, http = f.connection.http.bind(f.connection);
    f.connection.http = async (route: string, init?: RequestInit) => {
      if (route.includes("/file?")) {
        if (state === "failed") throw new Error("fixture_file_failed");
        await new Promise<void>(resolve => { f.releaseFile = resolve; });
      }
      try { return await http(route, init); }
      finally { if (route.includes("/file?")) f.fileSettled = true; }
    };
  }, state);
  await page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ }).click();
  if (state === "loading") await expect(page.getByText("正在读取文件改动…", { exact: true })).toBeVisible();
  else await expect(page.locator(".diff-content [role=alert]")).toBeVisible();
  expect(await nativeBack(page)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "本轮改动", exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog).not.toHaveClass(/has-file/);
  await page.evaluate(() => (window as any).runDiffFixture.releaseFile?.());
  if (state === "loading") await expect.poll(() => page.evaluate(() => !!(window as any).runDiffFixture.fileSettled)).toBe(true);
  await expect(page.getByRole("button", { name: /\/project\/src\/ReviewPanel/ })).toBeVisible();
  await expect(page.getByTestId("diff-code")).toHaveCount(0);
  expect(await nativeBack(page)).toBe(true); await expect(page.getByText("closed", { exact: true })).toBeVisible();
});

test("Back from live workspace returns to the recorded detail, then its list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await file(page).click(); await expect(page.getByTestId("diff-code")).toBeVisible();
  await page.getByRole("button", { name: "当前工作区（实时）" }).click();
  await expect(page.getByRole("dialog", { name: "工作区改动", exact: true })).toBeVisible();
  expect(await nativeBack(page)).toBe(true);
  const recorded = page.getByRole("dialog", { name: "本轮改动", exact: true });
  await expect(recorded).toBeVisible(); await expect(recorded).toHaveClass(/has-file/);
  expect(await nativeBack(page)).toBe(true);
  await expect(recorded).toBeVisible(); await expect(recorded).not.toHaveClass(/has-file/);
  expect(await nativeBack(page)).toBe(true); await expect(page.getByText("closed", { exact: true })).toBeVisible();
});
test("a slow viewer chunk opens exactly one changes sheet, without a placeholder sheet first (C-13)", async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = []; Object.assign(window, { openedDialogs: opened });
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { opened.push(this.getAttribute("aria-label") ?? ""); return showModal.call(this); };
  });
  // Hold the lazily loaded viewer module so the first open waits for it.
  await page.route("**/src/RunDiffViewer.tsx*", async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue(); });
  await page.goto(url + "?mode=trigger");
  const trigger = page.getByRole("button", { name: "改动 1 个文件 · +4 −2" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "本轮改动", exact: true })).toBeVisible();
  await expect(file(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).openedDialogs)).toEqual(["本轮改动"]);
  // Reopening uses the loaded module directly: still one presentation per open.
  await page.getByRole("dialog", { name: "本轮改动", exact: true }).getByRole("button", { name: "关闭改动查看器" }).click();
  await expect(page.getByRole("dialog", { name: "本轮改动", exact: true })).toHaveCount(0);
  await trigger.click(); await expect(file(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).openedDialogs)).toEqual(["本轮改动", "本轮改动"]);
});
