import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => server?.close());
const url = (query = "") => server.resolvedUrls!.local[0] + "e2e/fixtures/workbench-library.html" + query;
test.use({ serviceWorkers: "block" });
test("list spans hosts and closed files; filters clear selection and open keeps the exact target", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.getByLabel("选择：会议记录.md", { exact: true }).check();
  await page.getByLabel("工作台文件主机", { exact: true }).selectOption("hub-two");
  await expect(page.getByText("共 3 项", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除所选", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "打开：合同要点.md", exact: true }).click();
  expect(await page.evaluate(() => (window as any).workbenchLibraryFixture.opens)).toEqual([{ host: "hub-two", file: { scope: '["hub-two","owner","project"]', conversationId: "project", id: "note-one", kind: "markdown", title: "合同要点.md" } }]);
  await page.getByLabel("搜索工作台文件", { exact: true }).fill("客户方案");
  await expect(page.getByText("共 3 项", { exact: true })).toBeVisible();
  await page.getByLabel("工作台文件类型", { exact: true }).selectOption("whiteboard"); await expect(page.getByText("共 1 项", { exact: true })).toBeVisible();
});
test("empty historical workspaces do not hide later saved files from the manager", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const f = (window as any).workbenchLibraryFixture, cache = f.hosts[0].connection.cache;
    // Cleanup retains these records for browser-data ownership. They must not
    // permanently consume the content listing's scope allowance.
    const existing = await cache.readWorkbench(f.workbenchScope("hub-one", "owner", "project"));
    for (let i = 0; i < 1001; i++) {
      const scope = f.workbenchScope("hub-one", "owner", `000-history-${String(i).padStart(4, "0")}`);
      await cache.saveWorkbench(scope, -1, { ...existing, revision: 0, tabs: [], closed: [], visible: [], active: null, maximized: null });
    }
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开：会议记录.md", exact: true })).toBeEnabled();
});
test("cancel has no effect; confirmed bulk removal preserves other hosts and chats", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.getByLabel("选择：会议记录.md", { exact: true }).check(); await page.getByLabel("选择：产品流程白板", { exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  let confirm = page.getByRole("dialog", { name: "删除这 2 项工作台内容？", exact: true });
  await expect(confirm.getByText(/仅删除下面所选内容/)).toBeVisible(); await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  confirm = page.getByRole("dialog", { name: "删除这 2 项工作台内容？", exact: true }); await confirm.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await expect(page.getByText("已清理 2 项。", { exact: true })).toBeVisible(); await expect(page.getByText("共 6 项", { exact: true })).toBeVisible();
  const result = await page.evaluate(async () => { const f = (window as any).workbenchLibraryFixture; return { gone: await f.hosts[0].connection.cache.readWorkbenchMarkdown(f.workbenchScope("hub-one", "owner", "project"), "note-one"), other: await f.hosts[1].connection.cache.readWorkbenchMarkdown(f.workbenchScope("hub-two", "owner", "project"), "note-one"), conversation: await f.hosts[0].connection.cache.conversation("project") }; });
  expect(result.gone).toBeUndefined(); expect(result.other.content).toBe("Important saved content"); expect(result.conversation.title).toBe("产品讨论");
});
test("one confirmation deletes the selected files from both hosts without crossing their item IDs", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.getByLabel("选择：会议记录.md", { exact: true }).check();
  await page.getByLabel("选择：合同要点.md", { exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "删除这 2 项工作台内容？", exact: true });
  await expect(confirm.getByText("Mac mini · 产品讨论", { exact: true })).toBeVisible();
  await expect(confirm.getByText("工作电脑 · 客户方案", { exact: true })).toBeVisible();
  await confirm.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await expect(page.getByText("已清理 2 项。", { exact: true })).toBeVisible();
  await expect(page.getByText("共 6 项", { exact: true })).toBeVisible();
  const stored = await page.evaluate(async () => {
    const f = (window as any).workbenchLibraryFixture;
    return Promise.all(f.hosts.map(async ({ connection }: any) => {
      const scope = f.workbenchScope(connection.identity.hubPublicKey, "owner", "project");
      return { note: await connection.cache.readWorkbenchMarkdown(scope, "note-one"),
        board: !!await connection.cache.readWorkbenchBoard(scope, "board-one"),
        conversation: !!await connection.cache.conversation("project") };
    }));
  });
  expect(stored).toEqual([{ note: undefined, board: true, conversation: true }, { note: undefined, board: true, conversation: true }]);
});
test("a host change during deletion reports committed work and does not continue into the removed host", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).workbenchLibraryFixture, cache = f.hosts[0].connection.cache;
    const remove = cache.deleteWorkbenchItems.bind(cache);
    cache.deleteWorkbenchItems = async (...args: any[]) => {
      const receipt = await remove(...args); f.hideSecondHost();
      await new Promise(resolve => setTimeout(resolve, 100)); return receipt;
    };
  });
  await page.getByLabel("选择：会议记录.md", { exact: true }).check();
  await page.getByLabel("选择：合同要点.md", { exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await expect(page.getByText("已清理 1 项。主机或身份已变化，1 项未继续执行；请刷新核对结果。", { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const f = (window as any).workbenchLibraryFixture;
    return !!await f.hosts[1].connection.cache.readWorkbenchMarkdown(f.workbenchScope("hub-two", "owner", "project"), "note-one");
  })).toBe(true);
});
test("busy editor is retained while other selected content is removed, then explicit retry works", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).workbenchLibraryFixture.hold("markdown", "note-one"));
  await page.getByLabel("选择：会议记录.md", { exact: true }).check(); await page.getByLabel("选择：首页设计", { exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click(); await page.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await expect(page.getByText("已清理 1 项，1 项未删除。", { exact: true })).toBeVisible(); await expect(page.getByText(/正在编辑，请先关闭该标签后重试/)).toBeVisible();
  await expect(page.getByLabel("选择：会议记录.md", { exact: true })).toBeChecked();
  await page.evaluate(() => (window as any).workbenchLibraryFixture.release());
  await page.getByRole("button", { name: "删除所选", exact: true }).click(); await page.getByRole("button", { name: "删除 1 项", exact: true }).click();
  await expect(page.getByText("已清理 1 项。", { exact: true })).toBeVisible(); await expect(page.getByLabel("选择：会议记录.md", { exact: true })).toHaveCount(0);
});
test("archived and removed conversations remain cleanable without navigating into an unavailable conversation", async ({ page }) => {
  await page.goto(url()); await expect(page.getByText("共 8 项", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开：旧项目记录.md", exact: true })).toBeDisabled();
  await page.getByLabel("工作台文件状态", { exact: true }).selectOption("orphan");
  await expect(page.getByText("共 1 项", { exact: true })).toBeVisible(); await expect(page.locator(".workbench-library-list button")).toBeDisabled();
  await page.getByRole("button", { name: "选择本页", exact: true }).click(); await page.getByRole("button", { name: "删除所选", exact: true }).click(); await page.getByRole("button", { name: "删除 1 项", exact: true }).click();
  await expect(page.getByText("已清理 1 项。", { exact: true })).toBeVisible();
});
for (const english of [false, true]) test(`desktop and phone layout has usable controls (${english ? "en" : "zh"})`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 900 }); await page.goto(url(english ? "?en" : ""));
  await expect(page.getByText(english ? "8 items" : "共 8 项", { exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: english ? "Workbench files" : "工作台文件", exact: true });
  await expect(page.getByRole("searchbox")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await dialog.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await dialog.screenshot({ path: info.outputPath(`library-desktop-${english ? "en" : "zh"}.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(page.getByRole("button", { name: english ? "Delete selected" : "删除所选", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`library-phone-${english ? "en" : "zh"}.png`) });
});

for (const platform of ['ios','android']) test(`phone library filters keep compact labels and native picker targets (${platform})`, async ({browser},info) => {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const page=await context.newPage();
  try {
    await page.goto(url()); await expect(page.getByText('共 8 项',{exact:true})).toBeVisible();
    await page.evaluate(value => document.documentElement.dataset.platform=value,platform);
    const filter=page.getByLabel('工作台文件类型',{exact:true});
    await expect(filter).toHaveCSS('font-size','16px');
    await expect(filter.locator('+span')).toHaveCSS('font-size','13px');
    expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await filter.selectOption('markdown');
    await expect(filter.locator('+span')).toHaveText('笔记');
    await expect(page.getByText('共 4 项',{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath(`library-filters-${platform}.png`)});
  } finally {await context.close();}
});
