import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ resolve: { alias: { "@tauri-apps/api/menu": fileURLToPath(new URL("./fixtures/context-menu-native.ts", import.meta.url)) } }, server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/context-menu.html";
});
test.afterAll(async () => { await server.close(); });
const calls = (page: Page) => page.evaluate(() => (window as any).contextFixture.bridge.calls as { kind: string; items?: { item: string; text?: string }[] }[]);
async function settled(page: Page) { await expect.poll(async () => (await calls(page)).at(-1)?.kind).toBe("close"); }

test("desktop selection offers only native Copy and leaves the selection intact", async ({ page }) => {
  await page.goto(url);
  await page.locator("#prose").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await page.locator("#prose").click({ button: "right" }); await settled(page);
  expect((await calls(page))[0].items).toEqual([{ item: "Copy", text: "复制" }]);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Chrome 是本地排版验收文本。");
});
test("editable and readonly controls keep useful editing commands with localized labels", async ({ page }) => {
  await page.goto(url + "?locale=en");
  await page.getByLabel("消息").click({ button: "right" }); await settled(page);
  const items = (await calls(page))[0].items!;
  expect(items.filter(i => !["Undo", "Redo", "Separator"].includes(i.item))).toEqual([
    { item: "Cut", text: "Cut" }, { item: "Copy", text: "Copy" }, { item: "Paste", text: "Paste" }, { item: "SelectAll", text: "Select all" },
  ]);
  await page.evaluate(() => (window as any).contextFixture.bridge.calls = []);
  await page.getByLabel("只读").click({ button: "right" }); await settled(page);
  expect((await calls(page))[0].items?.map(i => i.item)).toEqual(["Copy", "SelectAll"]);
  await page.evaluate(() => (window as any).contextFixture.bridge.calls = []);
  await page.getByLabel("密码").click({ button: "right" }); await settled(page);
  const passwordItems = (await calls(page))[0].items!.map(i => i.item);
  expect(passwordItems).not.toContain("Copy");
  expect(passwordItems).not.toContain("Cut");
});
test("App-owned menus win and ordinary browsers keep their native context behavior", async ({ page }) => {
  await page.goto(url);
  await page.getByRole("button", { name: "测试对话" }).click({ button: "right" });
  await expect(page.locator("#result")).toHaveText("重命名"); expect(await calls(page)).toEqual([]);
  // WebKit can select a word in the button on right-click. This next case
  // explicitly exercises a context menu without any selected text.
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  // Nothing useful is available on blank prose: suppress the WebView extras.
  expect(await page.locator("#prose").evaluate(el => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  expect(await calls(page)).toEqual([]);
  await page.goto(url + "?platform=web");
  expect(await page.locator("#prose").evaluate(el => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(false);
});
test("late native menu creation cannot reopen after another click or disposal", async ({ page }) => {
  for (const action of ["click", "dispose"]) {
    await page.goto(url);
    await page.evaluate(() => (window as any).contextFixture.bridge.hold = true);
    await page.getByLabel("消息").click({ button: "right" });
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    if (action === "click") await page.locator("#prose").click(); else await page.evaluate(() => (window as any).contextFixture.stop());
    await page.evaluate(() => (window as any).contextFixture.bridge.pending()); await settled(page);
    expect((await calls(page)).map(c => c.kind)).toEqual(["new", "close"]);
  }
});
